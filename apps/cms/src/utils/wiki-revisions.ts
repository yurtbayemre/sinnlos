/**
 * Wiki page history: the read side of DA03 (decision 06 §J3; batch 16 lane
 * 16D, contract K15). The wiki-page history actions (lane 16B) call these;
 * nothing else reads revisions (no content-API route since batch 15.1).
 *
 * WHAT A REVISION IS. One row of wiki_revisions, anchored by
 * `pageDocumentId` (never by the `page` link: every revision gains a second
 * link row at publish, and which one a populate returns depends on the
 * engine, spike 5 S5.7). Its `kind`:
 *   - `after`: the page's draft right after a save (title, body, page
 *     summary), written by the wiki-page lifecycle;
 *   - `baseline`: the page's content at a cutover (the first boot of batch
 *     16, and every boot after a rollback window that changed it), written
 *     by the boot backfill (utils/revision-backfill.ts);
 *   - `before`: a legacy row of batches up to 15.1, the page body BEFORE an
 *     edit; it captured no title, and its `summary` is an edit note. A row
 *     the backfill has not reached yet (kind NULL) reads as `before`.
 * `summary` is always the edit note (`changeSummary` here); the page's own
 * summary at that state is `pageSummary`.
 *
 * WHO. `editor` is the users-permissions user of a web save; a panel save
 * carries `adminEditorId` instead (`{ admin: true }` here, no admin
 * identity leaves the cms); a baseline, a seed write or an unattributed
 * legacy row has neither (null).
 *
 * Fixed projections only: no client populate, filter or sort reaches the
 * query. The list carries no bodies.
 */

export const WIKI_REVISION_UID = "api::wiki-revision.wiki-revision";

export const REVISION_KINDS = ["before", "after", "baseline"] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];

/** The page size of `listRevisions` when the caller names none, and its cap. */
export const REVISION_PAGE_SIZE = 20;
export const REVISION_MAX_PAGE_SIZE = 100;

export type RevisionEditor = { id: number; displayName: string } | { admin: true };

/** One history entry (no body). */
export interface RevisionListEntry {
  id: number;
  /** ISO 8601. */
  createdAt: string | null;
  /** The page title at that state; null for a legacy `before` row. */
  title: string | null;
  /** The edit note the save carried. */
  changeSummary: string | null;
  kind: RevisionKind;
  /** null: unknown (a baseline, a seed write, an unattributed legacy row). */
  editor: RevisionEditor | null;
  /** The revision a restore brought back. */
  restoredFrom: number | null;
}

/** One revision with its content, for the preview and the restore. */
export interface RevisionDetail extends RevisionListEntry {
  body: string | null;
  /** The page's summary at that state; null for a legacy `before` row. */
  pageSummary: string | null;
}

export interface RevisionPagination {
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
}

export interface RevisionList {
  results: RevisionListEntry[];
  pagination: RevisionPagination;
}

/** The page fields a restore writes to the draft. */
export interface RestoreData {
  title?: string;
  body: string | null;
  summary?: string | null;
}

/** The slice of the Strapi instance the reads use. */
export interface WikiRevisionsHost {
  db: {
    query(uid: string): {
      findMany(params: Record<string, unknown>): Promise<unknown[]>;
      findOne(params: Record<string, unknown>): Promise<unknown>;
      count(params: Record<string, unknown>): Promise<number>;
    };
  };
}

const LIST_FIELDS = [
  "id",
  "createdAt",
  "title",
  "summary",
  "kind",
  "adminEditorId",
  "restoredFrom",
] as const;
const DETAIL_FIELDS = [...LIST_FIELDS, "body", "pageSummary"] as const;
const EDITOR = { editor: { select: ["id", "displayName", "username"] } };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** A positive safe integer, from a number or a numeric string (a bigint column on pg). */
export function positiveId(value: unknown): number | null {
  const id = typeof value === "string" && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

const isoOf = (value: unknown): string | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
};

/** A stored kind; NULL (not backfilled yet) and anything unknown read as a legacy `before`. */
export const kindOf = (value: unknown): RevisionKind =>
  value === "after" || value === "baseline" ? value : "before";

function editorOf(row: Record<string, unknown>): RevisionEditor | null {
  const editor = row.editor;
  if (isRecord(editor)) {
    const id = positiveId(editor.id);
    const name =
      typeof editor.displayName === "string" && editor.displayName !== ""
        ? editor.displayName
        : text(editor.username);
    if (id !== null && name !== null) return { id, displayName: name };
  }
  return positiveId(row.adminEditorId) !== null ? { admin: true } : null;
}

function entryOf(row: unknown): RevisionListEntry | null {
  if (!isRecord(row)) return null;
  const id = positiveId(row.id);
  if (id === null) return null;
  return {
    id,
    createdAt: isoOf(row.createdAt),
    title: text(row.title),
    changeSummary: text(row.summary),
    kind: kindOf(row.kind),
    editor: editorOf(row),
    restoredFrom: positiveId(row.restoredFrom),
  };
}

const wholeNumber = (value: unknown, fallback: number, max: number): number => {
  const n = typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
};

/**
 * The history of one page, newest first (by id: the order the rows were
 * written), without bodies. `page` is 1-based; `pageSize` defaults to
 * REVISION_PAGE_SIZE and is capped at REVISION_MAX_PAGE_SIZE.
 */
export async function listRevisions(
  strapi: WikiRevisionsHost,
  pageDocumentId: string,
  options: { page?: number; pageSize?: number } = {},
): Promise<RevisionList> {
  const pageSize = wholeNumber(options.pageSize, REVISION_PAGE_SIZE, REVISION_MAX_PAGE_SIZE);
  const page = wholeNumber(options.page, 1, Number.MAX_SAFE_INTEGER);
  const offset = (page - 1) * pageSize;
  const query = strapi.db.query(WIKI_REVISION_UID);
  const where = { pageDocumentId };
  const total = await query.count({ where });
  const rows =
    total > offset
      ? await query.findMany({
          where,
          select: [...LIST_FIELDS],
          populate: EDITOR,
          orderBy: { id: "desc" },
          offset,
          limit: pageSize,
        })
      : [];
  return {
    results: rows.map(entryOf).filter((entry): entry is RevisionListEntry => entry !== null),
    pagination: { page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)), total },
  };
}

/**
 * One revision of one page with its content; null when the id names no
 * revision of THIS page (another page's revision is indistinguishable from
 * a missing one).
 */
export async function getRevision(
  strapi: WikiRevisionsHost,
  pageDocumentId: string,
  revisionId: unknown,
): Promise<RevisionDetail | null> {
  const id = positiveId(revisionId);
  if (id === null || typeof pageDocumentId !== "string" || pageDocumentId === "") return null;
  const row = await strapi.db.query(WIKI_REVISION_UID).findOne({
    where: { id, pageDocumentId },
    select: [...DETAIL_FIELDS],
    populate: EDITOR,
  });
  const entry = entryOf(row);
  if (entry === null || !isRecord(row)) return null;
  return { ...entry, body: text(row.body), pageSummary: text(row.pageSummary) };
}

/**
 * What a restore writes to the page's draft (decision 06 §J3 "Restore"):
 *   - `after` and `baseline`: title, body and page summary;
 *   - `before` (legacy): the body only; the current title and summary stay.
 */
export function restoreData(revision: RevisionDetail): RestoreData {
  if (revision.kind === "before") return { body: revision.body };
  return {
    ...(revision.title !== null ? { title: revision.title } : {}),
    body: revision.body,
    summary: revision.pageSummary,
  };
}
