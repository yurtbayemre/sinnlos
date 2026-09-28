"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Command, defaultFilter } from "cmdk";
import {
  Search,
  BarChart3,
  Building2,
  Calendar,
  Contact,
  Users,
  BookOpen,
  FileText,
  Megaphone,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { PreloadKind, SearchItem, SearchKind } from "@/lib/search-action";

/*
 * The ⌘K palette (WD06). It talks to GET/POST /search (app/search/route.ts)
 * with fetch, never through Server Actions: those run one at a time per
 * client, so the typeahead used to block every other action and the
 * navigation after a selection. The logic below the component is plain
 * functions (search.test.ts drives them with fake timers):
 *   - preload: when the palette first opens, one GET /search?kind=<kind>
 *     per PALETTE_PRELOAD_KINDS kind, each shown as it arrives; people are
 *     not preloaded (the live search finds them);
 *   - live search from 2 characters, debounced by 300 ms; a newer term
 *     aborts the request in flight, and results are shown only for the term
 *     in the box: until that term settles the list shows "Loading…", never
 *     the previous term's results, nor the remembered results of the same
 *     term typed again (every scheduled search and every selection drops
 *     them);
 *   - telemetry: only SETTLED terms are logged (2 s stable, a selection, or
 *     closing the palette; the same term never twice in a row), sent as a
 *     keepalive POST that never throws — logging each debounced prefix
 *     ("of", "off", "offs", …) would bury the zero-result signal;
 *   - a redirect or 401 from /search means the session is gone: the page
 *     reloads, and proxy.ts or strapi() send it to the sign-in page.
 */

/** = PRELOAD_KINDS in lib/search-action.ts (pinned in search.test.ts). */
export const PALETTE_PRELOAD_KINDS: readonly PreloadKind[] = [
  "department",
  "team",
  "wiki-space",
  "wiki-page",
  "announcement",
  "event",
  "poll",
  "document",
];

/** = SEARCH_KINDS in lib/search-action.ts (pinned in search.test.ts). */
export const PALETTE_KINDS: ReadonlySet<SearchKind> = new Set<SearchKind>([
  "department",
  "team",
  "wiki-space",
  "wiki-page",
  "announcement",
  "person",
  "event",
  "poll",
  "document",
]);

export const SEARCH_DEBOUNCE_MS = 300;
export const SEARCH_LOG_SETTLE_MS = 2000;
export const MIN_QUERY_LENGTH = 2;

export const searchUrl = (term: string) => `/search?q=${encodeURIComponent(term)}`;
export const preloadUrl = (kind: PreloadKind) => `/search?kind=${kind}`;

/** /search answered with a redirect or 401: the session is gone. */
export class SessionExpiredError extends Error {
  constructor() {
    super("session expired");
    this.name = "SessionExpiredError";
  }
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The items of a /search answer; malformed entries and foreign links are dropped. */
export function parseSearchItems(body: unknown): SearchItem[] {
  if (!isRecord(body) || !Array.isArray(body.items)) return [];
  const items: SearchItem[] = [];
  const keys = new Set<string>();
  for (const entry of body.items) {
    if (!isRecord(entry)) continue;
    const { key, kind, title, subtitle, href } = entry;
    if (typeof key !== "string" || keys.has(key)) continue;
    if (typeof kind !== "string" || !PALETTE_KINDS.has(kind as SearchKind)) continue;
    if (typeof title !== "string" || title === "") continue;
    // In-app paths only: "/x", never "//host" or "/\host".
    if (typeof href !== "string" || !/^\/(?![/\\])/.test(href)) continue;
    keys.add(key);
    items.push({
      key,
      kind: kind as SearchKind,
      title,
      href: href as Route,
      ...(typeof subtitle === "string" && subtitle !== "" ? { subtitle } : {}),
    });
  }
  return items;
}

/**
 * GET a /search URL. Throws SessionExpiredError on a redirect (proxy.ts, or
 * strapi() on an expired Strapi JWT) or a 401, an Error on any other
 * failure, and the AbortError when `signal` aborts.
 */
export async function fetchSearchItems(
  url: string,
  signal: AbortSignal,
  fetchImpl: Fetch = fetch,
): Promise<SearchItem[]> {
  const res = await fetchImpl(url, {
    signal,
    cache: "no-store",
    redirect: "manual",
    headers: { accept: "application/json" },
  });
  if (
    res.type === "opaqueredirect" ||
    res.status === 0 ||
    res.status === 401 ||
    (res.status >= 300 && res.status < 400)
  ) {
    throw new SessionExpiredError();
  }
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
  return parseSearchItems(await res.json());
}

/** POST a settled term to /search. Fire and forget: never throws, never rejects. */
export function sendSearchLog(term: string, count: number, fetchImpl: Fetch = fetch): void {
  try {
    void fetchImpl("/search", {
      method: "POST",
      keepalive: true,
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ term, count }),
    }).catch(() => undefined);
  } catch {
    // Telemetry only.
  }
}

export interface SearchSchedulerDeps {
  /** Run the live search (fetchSearchItems in the palette). */
  search(term: string, signal: AbortSignal): Promise<SearchItem[]>;
  /**
   * A live search for `term` was scheduled (any term of 2+ characters,
   * the same one again included): results shown so far are stale.
   */
  onStart?(term: string): void;
  /** The results of `term`, the newest term only; a failed search is []. */
  onResults(term: string, items: SearchItem[]): void;
  onSessionExpired(): void;
  /** Log a settled term (sendSearchLog in the palette). */
  log(term: string, count: number): void;
  debounceMs?: number;
  settleMs?: number;
}

export interface SearchScheduler {
  /** The term in the box changed. */
  query(term: string): void;
  /** Log the pending settled term now (selection, palette closed). */
  flushLog(): void;
  /** Cancel everything and flush the log (unmount). */
  dispose(): void;
}

/** Debounce, abort and settled-term telemetry of the live search, framework free. */
export function createSearchScheduler({
  search,
  onStart,
  onResults,
  onSessionExpired,
  log,
  debounceMs = SEARCH_DEBOUNCE_MS,
  settleMs = SEARCH_LOG_SETTLE_MS,
}: SearchSchedulerDeps): SearchScheduler {
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let inflight: AbortController | null = null;
  let logTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingLog: { term: string; count: number } | null = null;
  let lastLogged = "";
  let disposed = false;

  const cancel = () => {
    if (debounce) clearTimeout(debounce);
    debounce = null;
    inflight?.abort();
    inflight = null;
  };

  const flushLog = () => {
    if (logTimer) clearTimeout(logTimer);
    logTimer = null;
    const pending = pendingLog;
    pendingLog = null;
    if (!pending || pending.term === lastLogged) return;
    lastLogged = pending.term;
    log(pending.term, pending.count);
  };

  const scheduleLog = (term: string, count: number) => {
    pendingLog = { term, count };
    if (logTimer) clearTimeout(logTimer);
    logTimer = setTimeout(flushLog, settleMs);
  };

  const run = (term: string) => {
    debounce = null;
    const controller = new AbortController();
    inflight = controller;
    search(term, controller.signal).then(
      (items) => {
        if (controller.signal.aborted) return;
        inflight = null;
        onResults(term, items);
        scheduleLog(term, items.length);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        inflight = null;
        if (error instanceof SessionExpiredError) {
          onSessionExpired();
          return;
        }
        // Settle the term so the palette stops loading; not logged, a
        // failure is no zero-result signal.
        onResults(term, []);
      },
    );
  };

  return {
    query(term) {
      if (disposed) return;
      cancel();
      if (term.length < MIN_QUERY_LENGTH) return;
      onStart?.(term);
      debounce = setTimeout(() => run(term), debounceMs);
    },
    flushLog,
    dispose() {
      disposed = true;
      cancel();
      flushLog();
    },
  };
}

/** cmdk filter over the item's title and subtitle (its `value` is the unique key). */
function matchText(_value: string, search: string, keywords?: string[]): number {
  return defaultFilter ? defaultFilter((keywords ?? []).join(" "), search) : 1;
}

function icon(kind: SearchKind) {
  switch (kind) {
    case "department":
      return <Building2 className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
    case "team":
      return <Users className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
    case "wiki-space":
      return <BookOpen className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
    case "wiki-page":
      return <FileText className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
    case "announcement":
      return <Megaphone className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
    case "person":
      return <Contact className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
    case "event":
      return <Calendar className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
    case "poll":
      return <BarChart3 className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
    case "document":
      return <FileText className="mr-2 h-4 w-4 shrink-0 opacity-60" />;
  }
}

type Preloaded = Partial<Record<PreloadKind, SearchItem[]>>;

export function SearchCommand() {
  const tSearch = useTranslations("search");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [preloaded, setPreloaded] = useState<Preloaded>({});
  const [results, setResults] = useState<{ term: string; items: SearchItem[] } | null>(null);
  const schedulerRef = useRef<SearchScheduler | null>(null);
  const preloadRef = useRef<AbortController | null>(null);
  // Kinds requested in this mount; a failed kind stays empty until reload.
  const requestedRef = useRef<Set<PreloadKind>>(new Set());

  const expireSession = useCallback(() => window.location.reload(), []);

  useEffect(() => {
    const scheduler = createSearchScheduler({
      search: (term, signal) => fetchSearchItems(searchUrl(term), signal),
      // A new request makes the remembered results stale, even for the
      // same term ("ada" → "ad" → "ada"): "Loading…" until it settles.
      onStart: () => setResults(null),
      onResults: (term, items) => setResults({ term, items }),
      onSessionExpired: expireSession,
      log: (term, count) => sendSearchLog(term, count),
    });
    const preload = new AbortController();
    schedulerRef.current = scheduler;
    preloadRef.current = preload;
    const requested = requestedRef.current;
    return () => {
      scheduler.dispose();
      preload.abort();
      // Aborted kinds load again on the next mount (React StrictMode remounts).
      requested.clear();
    };
  }, [expireSession]);

  // Preload each kind once, the first time the palette opens.
  useEffect(() => {
    const controller = preloadRef.current;
    if (!open || !controller) return;
    for (const kind of PALETTE_PRELOAD_KINDS) {
      if (requestedRef.current.has(kind)) continue;
      requestedRef.current.add(kind);
      fetchSearchItems(preloadUrl(kind), controller.signal).then(
        (items) => setPreloaded((prev) => ({ ...prev, [kind]: items })),
        (error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof SessionExpiredError) expireSession();
          else setPreloaded((prev) => ({ ...prev, [kind]: [] }));
        },
      );
    }
  }, [open, expireSession]);

  // Closing the palette settles the term.
  useEffect(() => {
    if (!open) schedulerRef.current?.flushLog();
  }, [open]);

  const onQueryChange = useCallback((value: string) => {
    setQuery(value);
    schedulerRef.current?.query(value);
  }, []);

  // Ctrl+K / Cmd+K shortcut
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const select = useCallback(
    (href: Route) => {
      // A selection is the strongest "this query settled" signal.
      schedulerRef.current?.flushLog();
      schedulerRef.current?.query("");
      setOpen(false);
      setQuery("");
      setResults(null);
      router.push(href);
    },
    [router],
  );

  const searching = query.length >= MIN_QUERY_LENGTH;
  const settled = searching && results !== null && results.term === query;
  const items: SearchItem[] = searching
    ? settled
      ? results.items
      : []
    : PALETTE_PRELOAD_KINDS.flatMap((kind) => preloaded[kind] ?? []);
  const loading = searching ? !settled : PALETTE_PRELOAD_KINDS.some((kind) => !preloaded[kind]);

  const grouped = new Map<SearchKind, SearchItem[]>();
  for (const item of items) {
    const group = grouped.get(item.kind);
    if (group) group.push(item);
    else grouped.set(item.kind, [item]);
  }

  const groupLabel: Record<SearchKind, string> = {
    department: tNav("departments"),
    team: tNav("teams"),
    "wiki-space": tNav("wiki"),
    "wiki-page": tNav("wiki"),
    announcement: tNav("announcements"),
    person: tNav("people"),
    event: tNav("events"),
    poll: tNav("polls"),
    document: tNav("documents"),
  };

  return (
    <>
      {/* Trigger — icon-only on phones, full search-input look from sm up */}
      <button
        type="button"
        aria-label={tSearch("label")}
        onClick={() => setOpen(true)}
        className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border bg-muted/40 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted/60 focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring sm:h-10 sm:w-full sm:max-w-xl sm:justify-start sm:pl-9 sm:pr-3"
      >
        <Search
          aria-hidden="true"
          className="h-4 w-4 sm:pointer-events-none sm:absolute sm:left-3 sm:top-1/2 sm:-translate-y-1/2"
        />
        <span className="hidden truncate sm:inline">{tSearch("placeholder")}</span>
        <kbd className="ml-auto hidden rounded border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-block">
          ⌘K
        </kbd>
      </button>

      {/* Command palette as a real modal (issue #31): Command.Dialog wraps
          Radix Dialog, which supplies the focus trap, Tab cycling, Escape,
          outside-click close and focus restore to the trigger — the
          previous hand-rolled portal announced aria-modal without making
          the background inert. Radix portals to <body>, which the repo
          requires anyway: the sticky topbar's backdrop-blur turns the
          header into the containing block for fixed descendants. Items
          carry their unique key as cmdk `value` and are matched on title
          and subtitle (`keywords`); from 2 characters the server's results
          are shown unfiltered. */}
      <Command.Dialog
        open={open}
        onOpenChange={setOpen}
        label={tSearch("globalSearch")}
        shouldFilter={!searching}
        filter={matchText}
        overlayClassName="fixed inset-0 z-50 animate-fade-in bg-background/60 backdrop-blur-sm"
        contentClassName="fixed inset-x-3 top-[4.5rem] z-50 mx-auto max-w-lg animate-scale-in"
        className="overflow-hidden rounded-2xl border bg-background shadow-2xl"
      >
        <div className="flex items-center border-b px-3">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <Command.Input
            value={query}
            onValueChange={onQueryChange}
            placeholder={tSearch("searchPlaceholder")}
            className="flex h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <Command.List className="max-h-80 overflow-y-auto p-2">
          {loading && (
            <Command.Loading>
              <div className="py-6 text-center text-sm text-muted-foreground">
                {tCommon("loading")}
              </div>
            </Command.Loading>
          )}
          {!loading && (
            <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
              {tCommon("noResults")}
            </Command.Empty>
          )}
          {[...grouped].map(([kind, groupItems]) => (
            <Command.Group
              key={kind}
              heading={groupLabel[kind]}
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
            >
              {groupItems.map((item) => (
                <Command.Item
                  key={item.key}
                  value={item.key}
                  keywords={[item.title, item.subtitle ?? ""]}
                  onSelect={() => select(item.href)}
                  className="flex cursor-pointer items-center rounded-md px-2 py-2 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
                >
                  {icon(item.kind)}
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{item.title}</div>
                    {item.subtitle && (
                      <div className="truncate text-xs text-muted-foreground">{item.subtitle}</div>
                    )}
                  </div>
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command.Dialog>
    </>
  );
}
