/**
 * The values of the wiki forms (deep-dive decision 06 §J1, §J2, §L4; batch
 * 16 plan, lane 16C items 4 and 5): a wiki space (/manage/wiki) and a wiki
 * page (the wiki editor). What the inputs hold, as plain strings, booleans
 * and lists, before any conversion; see lib/manage/values.ts for the rules
 * (empty values for a create, values from `editable` for an edit, and the
 * coercion every Server Action argument goes through). Pure.
 */
import type { WikiPageEditable, WikiSpaceEditable } from "@sinnlos/domain";

export interface WikiSpaceValues {
  name: string;
  /** An ICON_KEYS name, "" for the default, or a legacy value the admin panel stored. */
  icon: string;
  description: string;
  /** public | role | department | team (WIKI_SPACE_VISIBILITIES). */
  visibility: string;
  /** Role types, for a `role` space. */
  allowedRoles: string[];
  /** A department's documentId, for a `department` space, or "". */
  department: string;
  /** A team's documentId, for a `team` space, or "". */
  team: string;
}

export interface WikiPageValues {
  title: string;
  /** Markdown. */
  body: string;
  /** Plain text under the title and in the space's list. */
  summary: string;
  /** Comma-separated, as typed (the payload splits it). */
  tags: string;
  tocEnabled: boolean;
  /** 0..10000 as typed. */
  order: string;
  /** The parent page's documentId (same space), or "" for the top level. */
  parent: string;
  /** Moderators: the page's department (its head edits it), or "". */
  department: string;
  /** Moderators: the page's team (its lead edits it), or "". */
  team: string;
  /** The edit note for the history (`revisionSummary`), never stored on the page. */
  revisionSummary: string;
}

export function emptyWikiSpaceValues(): WikiSpaceValues {
  return {
    name: "",
    icon: "",
    description: "",
    visibility: "public",
    allowedRoles: [],
    department: "",
    team: "",
  };
}

export function emptyWikiPageValues(parent = ""): WikiPageValues {
  return {
    title: "",
    body: "",
    summary: "",
    tags: "",
    tocEnabled: true,
    order: "0",
    parent,
    department: "",
    team: "",
    revisionSummary: "",
  };
}

export function wikiSpaceValuesFromEditable(editable: WikiSpaceEditable): WikiSpaceValues {
  return {
    name: editable.name ?? "",
    icon: editable.icon ?? "",
    description: editable.description ?? "",
    visibility: editable.visibility ?? "public",
    allowedRoles: [...(editable.allowedRoles ?? [])],
    department: editable.department ?? "",
    team: editable.team ?? "",
  };
}

export function wikiPageValuesFromEditable(editable: WikiPageEditable): WikiPageValues {
  return {
    title: editable.title ?? "",
    body: editable.body ?? "",
    summary: editable.summary ?? "",
    tags: (editable.tags ?? []).filter((tag) => typeof tag === "string").join(", "),
    tocEnabled: editable.tocEnabled !== false,
    order: String(editable.order ?? 0),
    parent: editable.parent ?? "",
    department: editable.department ?? "",
    team: editable.team ?? "",
    revisionSummary: "",
  };
}

// ---------------------------------------------------------------------------
// Coercion of Server Action arguments

/** Longest single text before the checks (the Markdown max plus slack). */
const MAX_TEXT = 210_000;
/** Most entries a list argument keeps. */
const MAX_LIST = 20;

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === "string" ? value.slice(0, MAX_TEXT) : "");

const ids = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
      ].slice(0, MAX_LIST)
    : [];

export function coerceWikiSpaceValues(raw: unknown): WikiSpaceValues {
  const r = isRecord(raw) ? raw : {};
  return {
    name: str(r.name),
    icon: str(r.icon).trim(),
    description: str(r.description),
    visibility: str(r.visibility).trim(),
    allowedRoles: ids(r.allowedRoles),
    department: str(r.department).trim(),
    team: str(r.team).trim(),
  };
}

export function coerceWikiPageValues(raw: unknown): WikiPageValues {
  const r = isRecord(raw) ? raw : {};
  return {
    title: str(r.title),
    body: str(r.body),
    summary: str(r.summary),
    tags: str(r.tags),
    tocEnabled: r.tocEnabled !== false,
    order: str(r.order),
    parent: str(r.parent).trim(),
    department: str(r.department).trim(),
    team: str(r.team).trim(),
    revisionSummary: str(r.revisionSummary),
  };
}
