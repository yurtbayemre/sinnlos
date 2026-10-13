import { unstable_rethrow } from "next/navigation";
import {
  AUTHORING_LIST_MAX_QUERY,
  WIKI_REVISIONS_PAGE_SIZE,
  type AuthoringPagination,
  type WikiMyDraftRow,
  type WikiPageEditable,
  type WikiPageListRow,
  type WikiRevisionDetail,
  type WikiRevisionEntry,
  type WikiSpaceEditable,
  type WikiSpaceListRow,
} from "@sinnlos/domain";
import {
  fetchMyWikiDrafts,
  fetchWikiPageEditable,
  fetchWikiPageList,
  fetchWikiRevision,
  fetchWikiRevisions,
  fetchWikiSpaceEditable,
  fetchWikiSpaceList,
} from "@/lib/api/manage/wiki";
import { listWikiParentRows, wikiPageRef, wikiSpaceBySlug } from "@/lib/api/wiki";
import { isDocumentId } from "@/lib/entry-id";
import { walkAllPages } from "@/lib/paginate";
import { tryFetch } from "@/lib/safe-fetch";
import { editableLoad, isNotFoundError, type EditorLoad } from "./editor";
import { NO_PAGES, pageParam, type ListSearchParams } from "./list";

/**
 * The wiki's authoring pages (WD03; deep-dive decision 06 §J1, §J2, §L1;
 * batch 16 plan, lane 16C items 4-7): the view models of /manage/wiki (the
 * spaces, a space's page tree), the wiki editor (`editable`, the parent
 * options), /wiki/drafts and the history. Pages render these only.
 *
 * As for the K7 types (lib/loaders/manage/editor.ts, list.ts):
 *   - URL filters are untrusted: `q` trimmed and capped, `page` a bounded
 *     integer, a documentId or revision id checked before any request;
 *   - a 404 (missing, or no class on it: the cms answers like a hidden
 *     page) and a 403 (no grant) are both `notFound`: the page shows the
 *     not-found page and says nothing about whether the item exists. Known
 *     limitation, as on every page of the app: that page is streamed after
 *     the layout, so the web's status is 200, not 404 (the cms answers
 *     404; batch 16 plan S14, question 18);
 *   - anything else that fails is `failed` (the banner), never an empty
 *     list; the sign-in redirect of an expired session is never swallowed.
 */

const first = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? "";

// ---------------------------------------------------------------------------
// Spaces (/manage/wiki)

export interface WikiSpaceFilters {
  q: string;
  page: number;
}

/** The filters of a /manage/wiki URL. */
export function parseWikiSpaceFilters(params: ListSearchParams): WikiSpaceFilters {
  return {
    q: first(params.q).trim().slice(0, AUTHORING_LIST_MAX_QUERY),
    page: pageParam(params),
  };
}

export interface WikiSpaceListView {
  rows: WikiSpaceListRow[];
  pagination: AuthoringPagination;
  empty: boolean;
  failed: boolean;
}

/** One page of spaces (moderators). */
export async function loadWikiSpaceList(filters: WikiSpaceFilters): Promise<WikiSpaceListView> {
  const result = await tryFetch(
    () =>
      fetchWikiSpaceList({
        ...(filters.q ? { q: filters.q } : {}),
        ...(filters.page > 1 ? { page: filters.page } : {}),
      }),
    "manage-wiki",
  );
  const rows = Array.isArray(result.data?.data) ? result.data.data : [];
  return {
    rows,
    pagination: result.data?.meta?.pagination ?? { ...NO_PAGES, page: filters.page },
    empty: !result.failed && rows.length === 0,
    failed: result.failed,
  };
}

/** A space's form (moderators). */
export function loadWikiSpaceEditable(documentId: string): Promise<EditorLoad<WikiSpaceEditable>> {
  return editableLoad("manage-wiki", documentId, () => fetchWikiSpaceEditable(documentId));
}

// ---------------------------------------------------------------------------
// A space's page tree (/manage/wiki/[space])

export interface WikiTreeNode {
  row: WikiPageListRow;
  children: WikiTreeNode[];
}

const byOrder = (a: WikiTreeNode, b: WikiTreeNode) =>
  (a.row.order ?? 0) - (b.row.order ?? 0) ||
  a.row.label.localeCompare(b.row.label, undefined, { numeric: true, sensitivity: "base" }) ||
  a.row.documentId.localeCompare(b.row.documentId);

/**
 * The page tree of one space from its authoring rows (every status): each
 * row below its parent, by `order`, then title. A row whose parent is not
 * in the list (another space, a page this list does not hold) is a root;
 * so is every row of a parent loop that no root reaches (a legacy loop the
 * admin panel made before batch 16): nothing is left out, and nothing is
 * listed twice.
 */
export function buildWikiTree(rows: readonly WikiPageListRow[]): WikiTreeNode[] {
  const nodes = new Map<string, WikiTreeNode>();
  for (const row of rows) {
    if (!nodes.has(row.documentId)) nodes.set(row.documentId, { row, children: [] });
  }
  const roots: WikiTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.row.parent ? nodes.get(node.row.parent) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  // Rows only a loop reaches: walk from the roots, then promote the rest.
  const reached = new Set<WikiTreeNode>();
  const walk = (node: WikiTreeNode) => {
    if (reached.has(node)) return;
    reached.add(node);
    node.children.forEach(walk);
  };
  roots.forEach(walk);
  for (const node of nodes.values()) {
    if (reached.has(node)) continue;
    // Cut the loop at this node: it becomes a root, its parent no longer lists it.
    const parent = node.row.parent ? nodes.get(node.row.parent) : undefined;
    if (parent) parent.children = parent.children.filter((child) => child !== node);
    roots.push(node);
    walk(node);
  }
  const sortDeep = (list: WikiTreeNode[]) => {
    list.sort(byOrder);
    list.forEach((node) => sortDeep(node.children));
  };
  sortDeep(roots);
  return roots;
}

export interface WikiTreeView {
  nodes: WikiTreeNode[];
  total: number;
  failed: boolean;
  /** The walk stopped at its cap: the tree may miss pages. */
  truncated: boolean;
}

/** Every page of a space (moderators' authoringList, all statuses), as a tree. */
export async function loadWikiPageTree(spaceDocumentId: string): Promise<WikiTreeView> {
  if (!isDocumentId(spaceDocumentId))
    return { nodes: [], total: 0, failed: false, truncated: false };
  const result = await tryFetch(
    () =>
      walkAllPages<WikiPageListRow>((page) => fetchWikiPageList({ space: spaceDocumentId, page }), {
        maxPages: 40,
        label: "manage-wiki tree",
      }),
    "manage-wiki",
  );
  const rows = result.data?.data ?? [];
  return {
    nodes: buildWikiTree(rows),
    total: rows.length,
    failed: result.failed,
    truncated: result.data?.truncated ?? false,
  };
}

// ---------------------------------------------------------------------------
// The wiki editor

/** A page's form (its row classes and moderators). */
export function loadWikiPageEditable(documentId: string): Promise<EditorLoad<WikiPageEditable>> {
  return editableLoad("manage-wiki", documentId, () => fetchWikiPageEditable(documentId));
}

/**
 * The page an editor or history URL names: `?doc=` when it is a documentId
 * (a draft has no published slug route), else the published page with the
 * URL's slugs. null: no such page the caller can read; `failed`: the read
 * failed.
 */
export async function resolveWikiPageId(
  spaceSlug: string,
  pageSlug: string,
  doc: string | string[] | undefined,
): Promise<{ documentId: string | null; failed: boolean }> {
  const fromQuery = first(doc);
  if (isDocumentId(fromQuery)) return { documentId: fromQuery, failed: false };
  const result = await tryFetch(() => wikiPageRef(spaceSlug, pageSlug), "manage-wiki");
  const row = result.data?.data?.[0];
  return { documentId: row?.documentId ?? null, failed: result.failed };
}

/** A space as the new-page form needs it: its documentId, name and slug (null: not readable). */
export async function loadWikiSpaceRef(
  spaceSlug: string,
): Promise<{ space: { documentId: string; name: string; slug: string } | null; failed: boolean }> {
  const result = await tryFetch(() => wikiSpaceBySlug(spaceSlug), "manage-wiki");
  const row = result.data?.data?.[0];
  return {
    space:
      row && row.documentId ? { documentId: row.documentId, name: row.name, slug: row.slug } : null,
    failed: result.failed,
  };
}

export interface WikiParentOption {
  documentId: string;
  /** The title with its ancestors ("Handbook / Setup / Linux"). */
  label: string;
}

export interface WikiParentOptionsView {
  options: WikiParentOption[];
  failed: boolean;
  truncated: boolean;
}

/**
 * The parent picker's options: the space's published pages (what the
 * caller reads), each labelled with its path, without `exclude` and its
 * subpages (choosing one would put the page below itself; the cms refuses
 * it as `parentCycle` anyway, for every writer).
 */
export async function loadWikiParentOptions(
  spaceSlug: string,
  exclude: string | null = null,
): Promise<WikiParentOptionsView> {
  const result = await tryFetch(() => listWikiParentRows(spaceSlug), "manage-wiki");
  const rows = result.data?.data ?? [];
  const byId = new Map(rows.map((row) => [row.documentId, row]));
  const parentOf = (row: (typeof rows)[number]) =>
    row.parent?.documentId && byId.has(row.parent.documentId) ? row.parent.documentId : null;
  /** The ancestors of a row, nearest last; stops at a loop. */
  const path = (row: (typeof rows)[number]): string[] => {
    const titles = [row.title];
    const seen = new Set([row.documentId]);
    let parent = parentOf(row);
    while (parent && !seen.has(parent) && titles.length < 20) {
      seen.add(parent);
      const next = byId.get(parent)!;
      titles.unshift(next.title);
      parent = parentOf(next);
    }
    return titles;
  };
  const isBelowExcluded = (row: (typeof rows)[number]): boolean => {
    if (!exclude) return false;
    const seen = new Set<string>();
    let current: string | null = row.documentId;
    while (current && !seen.has(current)) {
      if (current === exclude) return true;
      seen.add(current);
      const next = byId.get(current);
      current = next ? parentOf(next) : null;
    }
    return false;
  };
  const options = rows
    .filter((row) => !isBelowExcluded(row))
    .map((row) => ({ documentId: row.documentId, label: path(row).join(" / ") }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  return { options, failed: result.failed, truncated: result.data?.truncated ?? false };
}

// ---------------------------------------------------------------------------
// The two authoring routes inside the readers' slug namespace

/**
 * Whether an address without the authoring marker belongs to the readers
 * (lib/manage/wiki-paths.ts): /wiki/[space]/new when the space has a
 * published page with the slug `new`, /wiki/drafts when a readable space
 * has the slug `drafts`. Only a lookup that SUCCEEDED and found nothing
 * hands the address to the authoring page; a failed one keeps it with the
 * readers, whose page reads again and shows its own error and retry
 * (Codex review, round 2), never an unrelated form.
 */
export async function shadowedWikiPage(spaceSlug: string): Promise<boolean> {
  const result = await tryFetch(() => wikiPageRef(spaceSlug, "new"), "manage-wiki");
  return result.failed || (result.data?.data?.length ?? 0) > 0;
}

/** The same for /wiki/drafts and a space with the slug `drafts`. */
export async function shadowedWikiSpace(): Promise<boolean> {
  const result = await tryFetch(() => wikiSpaceBySlug("drafts"), "manage-wiki");
  return result.failed || (result.data?.data?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// /wiki/drafts

export interface MyWikiDraftsView {
  rows: WikiMyDraftRow[];
  failed: boolean;
}

/** The caller's pages with unpublished changes (every wiki-page updater). */
export async function loadMyWikiDrafts(): Promise<MyWikiDraftsView> {
  const result = await tryFetch(() => fetchMyWikiDrafts(), "manage-wiki");
  return {
    rows: Array.isArray(result.data?.data) ? result.data.data : [],
    failed: result.failed,
  };
}

// ---------------------------------------------------------------------------
// The history

export interface WikiHistoryView {
  state: "ok" | "notFound" | "failed";
  entries: WikiRevisionEntry[];
  pagination: AuthoringPagination;
}

/** One page of a page's history, newest first (its row classes and moderators). */
export async function loadWikiHistory(documentId: string, page: number): Promise<WikiHistoryView> {
  const empty = { ...NO_PAGES, pageSize: WIKI_REVISIONS_PAGE_SIZE, page };
  if (!isDocumentId(documentId)) return { state: "notFound", entries: [], pagination: empty };
  try {
    const answer = await fetchWikiRevisions(documentId, page);
    return {
      state: "ok",
      entries: Array.isArray(answer?.data) ? answer.data : [],
      pagination: answer?.meta?.pagination ?? empty,
    };
  } catch (error) {
    unstable_rethrow(error);
    if (isNotFoundError(error)) return { state: "notFound", entries: [], pagination: empty };
    console.error("[manage-wiki] revisions failed", error);
    return { state: "failed", entries: [], pagination: empty };
  }
}

/** The revision id of the URL's `rev`, or null. */
export function revisionParam(params: ListSearchParams): number | null {
  const value = first(params.rev);
  if (!/^\d{1,10}$/.test(value)) return null;
  const id = Number(value);
  return id > 0 && id <= 2147483647 ? id : null;
}

export type WikiRevisionLoad =
  { state: "ok"; revision: WikiRevisionDetail } | { state: "notFound" } | { state: "failed" };

/** One revision with its content (another page's revision answers 404). */
export async function loadWikiRevision(
  documentId: string,
  revisionId: number,
): Promise<WikiRevisionLoad> {
  if (!isDocumentId(documentId)) return { state: "notFound" };
  try {
    const revision = (await fetchWikiRevision(documentId, revisionId))?.data;
    if (!revision || revision.id !== revisionId) return { state: "notFound" };
    return { state: "ok", revision };
  } catch (error) {
    unstable_rethrow(error);
    if (isNotFoundError(error)) return { state: "notFound" };
    console.error("[manage-wiki] revision failed", error);
    return { state: "failed" };
  }
}
