/**
 * Global search (⌘K), server side (WD06, the web part of FX22). The palette
 * (components/search-command.tsx) calls GET /search (app/search/route.ts)
 * with fetch and an AbortController; this module builds the Strapi queries,
 * maps the rows to typed SearchItems and writes the search telemetry.
 *
 * Why a route and no longer Server Actions: Next.js runs a client's Server
 * Actions one at a time, so every typeahead request queued behind the
 * previous one and blocked every other action (a reaction, a mark-read) and
 * the navigation that follows a selection. A GET can be aborted when the
 * term changes. The route is outside /api (the edge sends /api to Strapi,
 * docs/architecture.md §5.1) and not public in proxy.ts.
 *
 * Rules:
 *   - Contact fields: only staff (CONTACT_SEARCH_ROLES = the cms
 *     PRIVILEGED_ROLE_TYPES, pinned in infra/contracts.test.ts) search
 *     people by email. For every other role the cms refuses an email
 *     filter with a 400 (middlewares/sensitive-query-guard.ts), so the
 *     clause is not sent.
 *   - /api/users ignores pagination[]: the people query pages with
 *     start/limit and an explicit sort (docs/architecture.md §5.25).
 *   - Bounded: every live query takes LIVE_LIMIT rows per kind; the preload
 *     is field-limited, departments/teams/wiki spaces are complete page
 *     walks (issue #26), the other kinds keep their windows (wiki pages
 *     100, announcements 20, upcoming events 50, polls 20, documents 50).
 *     People are not preloaded: the live search finds them.
 *   - Typed: rows come in as unknown and go through toSearchItems(); a row
 *     without the fields its link needs is skipped.
 *   - Per user and uncached: every read goes through strapi() (no-store,
 *     the caller's JWT, D-DC01).
 */
import "server-only";
import type { Route } from "next";
import { unstable_rethrow } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { appTimeZone } from "@/lib/app-time-zone";
import { walkAllPages } from "@/lib/paginate";
import { instantEpochMs, zonedDateKey, zonedDayStart } from "@/lib/plain-date";
import { strapi, type StrapiListResponse } from "@/lib/strapi";

export const SEARCH_KINDS = [
  "department",
  "team",
  "wiki-space",
  "wiki-page",
  "announcement",
  "person",
  "event",
  "poll",
  "document",
] as const;

export type SearchKind = (typeof SEARCH_KINDS)[number];

export type SearchItem = {
  /** Unique within one result list: kind plus documentId (people: id). */
  key: string;
  kind: SearchKind;
  title: string;
  subtitle?: string;
  href: Route;
};

/** The kinds the palette preloads, one GET /search?kind=<kind> each. */
export const PRELOAD_KINDS = [
  "department",
  "team",
  "wiki-space",
  "wiki-page",
  "announcement",
  "event",
  "poll",
  "document",
] as const satisfies readonly SearchKind[];

export type PreloadKind = (typeof PRELOAD_KINDS)[number];

/** The kinds the live search queries, in the order they are listed. */
export const LIVE_KINDS = [
  "announcement",
  "wiki-page",
  "document",
  "event",
  "poll",
  "person",
] as const satisfies readonly SearchKind[];

export type LiveKind = (typeof LIVE_KINDS)[number];

/** Shorter terms are answered by the preload (filtered in the browser). */
export const MIN_TERM_LENGTH = 2;
/** Longer terms are cut (a search box, not a query language). */
export const MAX_TERM_LENGTH = 100;
/** Rows per kind in the live search. */
export const LIVE_LIMIT = 5;

/**
 * Roles that may search people by e-mail: the staff roles that read contact
 * fields (cms utils/sanitize-user-contact.ts PRIVILEGED_ROLE_TYPES). Exact
 * and fail-closed like lib/roles.ts.
 */
export const CONTACT_SEARCH_ROLES: ReadonlySet<string> = new Set([
  "admin_role",
  "editor",
  "department_head",
  "team_lead",
  "member",
]);

export function canSearchByEmail(role: string | null | undefined): boolean {
  return typeof role === "string" && CONTACT_SEARCH_ROLES.has(role);
}

export function isPreloadKind(value: unknown): value is PreloadKind {
  return typeof value === "string" && (PRELOAD_KINDS as readonly string[]).includes(value);
}

/** The term as the live search uses it: cut to MAX_TERM_LENGTH. */
export function normalizeTerm(term: string): string {
  return term.slice(0, MAX_TERM_LENGTH);
}

// ---------------------------------------------------------------------------
// Query building (pure)
// ---------------------------------------------------------------------------

/** The Strapi path of each live-search kind for `term` and the viewer's role. */
export function liveSearchPaths(term: string, role: string | null): Record<LiveKind, string> {
  const q = encodeURIComponent(normalizeTerm(term));
  const page = `pagination[pageSize]=${LIVE_LIMIT}`;
  const people = [
    `filters[$or][0][displayName][$containsi]=${q}`,
    `filters[$or][1][jobTitle][$containsi]=${q}`,
    ...(canSearchByEmail(role) ? [`filters[$or][2][email][$containsi]=${q}`] : []),
    "fields[0]=displayName",
    "fields[1]=username",
    "fields[2]=jobTitle",
    "populate[department][fields][0]=name",
    "sort[0]=displayName:asc",
    "sort[1]=id:asc",
    "start=0",
    `limit=${LIVE_LIMIT}`,
  ].join("&");
  return {
    announcement: `/api/announcements?filters[$or][0][title][$containsi]=${q}&filters[$or][1][body][$containsi]=${q}&fields[0]=title&populate[author][fields][0]=displayName&sort[0]=createdAt:desc&${page}`,
    "wiki-page": `/api/wiki-pages?filters[$or][0][title][$containsi]=${q}&filters[$or][1][body][$containsi]=${q}&fields[0]=title&fields[1]=slug&fields[2]=summary&populate[space][fields][0]=name&populate[space][fields][1]=slug&sort[0]=title:asc&${page}`,
    document: `/api/documents?filters[$or][0][title][$containsi]=${q}&filters[$or][1][description][$containsi]=${q}&fields[0]=title&fields[1]=description&fields[2]=category&sort[0]=title:asc&${page}`,
    event: `/api/events?filters[title][$containsi]=${q}&fields[0]=title&fields[1]=start&sort[0]=start:desc&${page}`,
    poll: `/api/polls?filters[question][$containsi]=${q}&fields[0]=question&fields[1]=closesAt&sort[0]=createdAt:desc&${page}`,
    person: `/api/users?${people}`,
  };
}

/**
 * The Strapi path of a preload kind. `page` is the page of the complete
 * walks (department, team, wiki-space); `fromIso` the start of the
 * upcoming-events window.
 */
export function preloadPath(kind: PreloadKind, page: number, fromIso: string): string {
  const walk = (sort: string) => `${sort}&pagination[page]=${page}&pagination[pageSize]=100`;
  switch (kind) {
    case "department":
      return `/api/departments?fields[0]=name&fields[1]=slug&fields[2]=description&${walk("sort[0]=name:asc&sort[1]=id:asc")}`;
    case "team":
      return `/api/teams?fields[0]=name&fields[1]=slug&fields[2]=description&populate[department][fields][0]=name&${walk("sort[0]=name:asc&sort[1]=id:asc")}`;
    case "wiki-space":
      return `/api/wiki-spaces?fields[0]=name&fields[1]=slug&fields[2]=description&${walk("sort[0]=name:asc&sort[1]=id:asc")}`;
    case "wiki-page":
      return "/api/wiki-pages?fields[0]=title&fields[1]=slug&fields[2]=summary&populate[space][fields][0]=name&populate[space][fields][1]=slug&sort[0]=title:asc&sort[1]=id:asc&pagination[pageSize]=100";
    case "announcement":
      return "/api/announcements?fields[0]=title&populate[author][fields][0]=displayName&sort[0]=pinned:desc&sort[1]=createdAt:desc&pagination[pageSize]=20";
    case "event":
      return `/api/events?filters[start][$gte]=${encodeURIComponent(fromIso)}&fields[0]=title&fields[1]=start&sort[0]=start:asc&pagination[pageSize]=50`;
    case "poll":
      return "/api/polls?fields[0]=question&fields[1]=closesAt&sort[0]=createdAt:desc&pagination[pageSize]=20";
    case "document":
      return "/api/documents?fields[0]=title&fields[1]=description&fields[2]=category&sort[0]=updatedAt:desc&sort[1]=id:desc&pagination[pageSize]=50";
  }
}

/** Kinds whose preload is a complete page walk, with their page cap. */
const WALKED: Partial<Record<PreloadKind, number>> = {
  department: 10,
  team: 20,
  "wiki-space": 10,
};

// ---------------------------------------------------------------------------
// Mapping (pure)
// ---------------------------------------------------------------------------

/** What the mapper needs from the locale: dates and the poll wording. */
export interface SearchFormat {
  /** An event start as a date ("Oct 5, 2026"); undefined for an invalid value. */
  eventDate(iso: string): string | undefined;
  /** A poll deadline as "Closes <date>"; undefined for an invalid value. */
  pollCloses(iso: string): string | undefined;
  pollOpen: string;
  unknown: string;
}

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A non-empty string field, else undefined. */
const text = (row: Row | undefined, key: string): string | undefined => {
  const value = row?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};

const relation = (row: Row, key: string): Row | undefined => {
  const value = row[key];
  return isRow(value) ? value : undefined;
};

/** kind:documentId, or kind:id for rows without one; undefined without both. */
function keyOf(kind: SearchKind, row: Row): string | undefined {
  const documentId = text(row, "documentId");
  if (documentId) return `${kind}:${documentId}`;
  return typeof row.id === "number" ? `${kind}:${row.id}` : undefined;
}

const joined = (...parts: Array<string | undefined>) =>
  parts.filter((part): part is string => Boolean(part)).join(" · ") || undefined;

const path = (...segments: string[]) => `/${segments.map(encodeURIComponent).join("/")}` as Route;

function toItem(kind: SearchKind, row: Row, format: SearchFormat): SearchItem | null {
  const key = keyOf(kind, row);
  if (!key) return null;
  const item = (title: string | undefined, href: Route | undefined, subtitle?: string) =>
    title && href ? { key, kind, title, href, ...(subtitle ? { subtitle } : {}) } : null;

  switch (kind) {
    case "department": {
      const slug = text(row, "slug");
      return item(
        text(row, "name"),
        slug ? path("departments", slug) : undefined,
        text(row, "description"),
      );
    }
    case "team": {
      const slug = text(row, "slug");
      const department = text(relation(row, "department"), "name");
      const description = text(row, "description");
      return item(
        text(row, "name"),
        slug ? path("teams", slug) : undefined,
        department ? `${department} · ${description ?? ""}` : description,
      );
    }
    case "wiki-space": {
      const slug = text(row, "slug");
      return item(
        text(row, "name"),
        slug ? path("wiki", slug) : undefined,
        text(row, "description"),
      );
    }
    case "wiki-page": {
      const space = relation(row, "space");
      const spaceSlug = text(space, "slug");
      const slug = text(row, "slug");
      return item(
        text(row, "title"),
        spaceSlug && slug ? path("wiki", spaceSlug, slug) : undefined,
        joined(text(space, "name") ?? spaceSlug, text(row, "summary")),
      );
    }
    case "announcement":
      return item(
        text(row, "title"),
        "/announcements",
        text(relation(row, "author"), "displayName"),
      );
    case "event": {
      const start = text(row, "start");
      return item(text(row, "title"), "/events", start ? format.eventDate(start) : undefined);
    }
    case "poll": {
      const closesAt = text(row, "closesAt");
      return item(
        text(row, "question"),
        "/polls",
        closesAt ? format.pollCloses(closesAt) : format.pollOpen,
      );
    }
    case "document":
      return item(
        text(row, "title"),
        "/documents",
        text(row, "description") ?? text(row, "category"),
      );
    case "person": {
      if (typeof row.id !== "number") return null;
      const title =
        text(row, "displayName") ?? text(row, "username") ?? text(row, "email") ?? format.unknown;
      return item(
        title,
        path("people", String(row.id)),
        joined(text(row, "jobTitle"), text(relation(row, "department"), "name")),
      );
    }
  }
}

/**
 * Map Strapi rows of one kind to SearchItems. Accepts the row array or a
 * `{ data }` list response; anything else, and every row without the fields
 * its link needs, maps to nothing. Duplicate keys are dropped.
 */
export function toSearchItems(kind: SearchKind, rows: unknown, format: SearchFormat): SearchItem[] {
  const list = Array.isArray(rows)
    ? rows
    : isRow(rows) && Array.isArray(rows.data)
      ? rows.data
      : [];
  const seen = new Set<string>();
  const items: SearchItem[] = [];
  for (const row of list) {
    if (!isRow(row)) continue;
    const item = toItem(kind, row, format);
    if (!item || seen.has(item.key)) continue;
    seen.add(item.key);
    items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Loading (server)
// ---------------------------------------------------------------------------

/**
 * Snippet dates in APP_TIME_ZONE (datetime contract, phase 2), with the
 * same fields as before the port: an event's day, and a poll's closing day
 * in the locale's numeric date (a web-form poll closes at 23:59:59 there,
 * so the day shown is the day chosen). Instants without Z or an offset are
 * no dates (plain-date.instantEpochMs).
 */
export function searchFormatFor(
  locale: string,
  timeZone: string,
  labels: { pollCloses: (date: string) => string; pollOpen: string; unknown: string },
): SearchFormat {
  const eventDay = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  });
  const closingDay = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone,
  });
  const valid = (iso: string) => {
    const ms = instantEpochMs(iso);
    return ms === null ? undefined : new Date(ms);
  };
  return {
    eventDate: (iso) => {
      const date = valid(iso);
      return date ? eventDay.format(date) : undefined;
    },
    pollCloses: (iso) => {
      const date = valid(iso);
      return date ? labels.pollCloses(closingDay.format(date)) : undefined;
    },
    pollOpen: labels.pollOpen,
    unknown: labels.unknown,
  };
}

async function searchFormat(): Promise<SearchFormat> {
  const [locale, tSearch, tCommon] = await Promise.all([
    getLocale(),
    getTranslations("search"),
    getTranslations("common"),
  ]);
  return searchFormatFor(locale, appTimeZone(), {
    pollCloses: (date) => tSearch("pollCloses", { date }),
    pollOpen: tSearch("pollOpen"),
    unknown: tCommon("unknown"),
  });
}

/**
 * A failed read is an empty kind: the palette is best effort (guest, for
 * example, holds no announcement grant). Next.js control flow (the redirect
 * strapi() raises on an expired session) is rethrown.
 */
async function rowsOf(read: () => Promise<unknown>): Promise<unknown> {
  try {
    return await read();
  } catch (e) {
    unstable_rethrow(e);
    return [];
  }
}

/** The preload of one kind for the current viewer. */
export async function loadPreload(
  kind: PreloadKind,
  now: Date = new Date(),
): Promise<SearchItem[]> {
  // Upcoming events from the start of today in APP_TIME_ZONE (datetime
  // contract, phase 2; the process zone is UTC in the container).
  const timeZone = appTimeZone();
  const fromIso = zonedDayStart(zonedDateKey(now, timeZone), timeZone).toISOString();
  const maxPages = WALKED[kind];
  const [format, rows] = await Promise.all([
    searchFormat(),
    rowsOf(() =>
      maxPages
        ? walkAllPages<unknown>(
            (page) => strapi<StrapiListResponse<unknown>>(preloadPath(kind, page, fromIso)),
            { maxPages, label: `search ${kind}` },
          )
        : strapi<StrapiListResponse<unknown>>(preloadPath(kind, 1, fromIso)),
    ),
  ]);
  return toSearchItems(kind, rows, format);
}

/**
 * The live search for `term`: LIVE_LIMIT rows of each LIVE_KINDS kind, in
 * that order. `viewerRole` resolves the viewer's role, which decides the
 * e-mail clause of the people query; it is called only for a term long
 * enough to search, and only the people query waits for it.
 */
export async function searchLive(
  term: string,
  viewerRole: () => Promise<string | null>,
): Promise<SearchItem[]> {
  if (term.length < MIN_TERM_LENGTH) return [];
  // Only the people query depends on the role.
  const paths = liveSearchPaths(term, null);
  const [format, ...lists] = await Promise.all([
    searchFormat(),
    ...LIVE_KINDS.map((kind) =>
      rowsOf(async () =>
        strapi<unknown>(
          kind === "person" ? liveSearchPaths(term, await viewerRole()).person : paths[kind],
        ),
      ),
    ),
  ]);
  return LIVE_KINDS.flatMap((kind, index) => toSearchItems(kind, lists[index], format));
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/** A search-log entry from the palette's POST body, or null. */
export function parseSearchLog(body: unknown): { term: string; count: number } | null {
  if (!isRow(body) || typeof body.term !== "string") return null;
  const count = typeof body.count === "number" && Number.isFinite(body.count) ? body.count : 0;
  return { term: body.term, count };
}

/**
 * Anonymous search instrumentation (issue #19, stage 1). The palette sends
 * only SETTLED terms (2 s stable, a selection, or close), never every
 * prefix. Never throws for a failed write (telemetry only); Next.js control
 * flow is rethrown like everywhere else.
 */
export async function logSearch(term: string, resultCount: number): Promise<void> {
  const trimmed = term.trim();
  if (trimmed.length < MIN_TERM_LENGTH) return;
  try {
    await strapi("/api/search-logs", {
      method: "POST",
      body: JSON.stringify({
        // The cms normalises both again (utils/search-log-input.ts: 120
        // characters, 0..100000).
        data: {
          term: trimmed.slice(0, 120),
          resultCount: Number.isFinite(resultCount) ? Math.max(0, Math.trunc(resultCount)) : 0,
        },
      }),
    });
  } catch (e) {
    unstable_rethrow(e);
    // Swallow: telemetry only.
  }
}
