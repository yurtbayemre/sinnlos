/**
 * The wiki's v2 authoring routes for the integration suites (batch 16 lane
 * 16B; the HTTP contract is @sinnlos/domain authoring/wiki.ts): one call
 * per intent, `If-Match` from the version the caller passes, as the web
 * sends it, plus the spaces and pages a suite seeds through the Document
 * Service (the admin panel's path, so the middlewares run).
 *
 * Named *.test.helper.ts like harness.test.helper.ts: not a suite, not part
 * of the cms build.
 */
import type { Answer } from "./authoring.test.helper";
import type { Caller, Row, TestStrapi } from "./harness.test.helper";

export const WIKI_SPACE = "api::wiki-space.wiki-space";
export const WIKI_PAGE = "api::wiki-page.wiki-page";

const ifMatch = (version: string | number | null | undefined): Record<string, string> =>
  version === null || version === undefined ? {} : { "If-Match": `"${version}"` };

/** The `data` of a wiki write answer (@sinnlos/domain WikiPageResult / WikiSpaceResult). */
export interface WikiDto {
  documentId: string;
  version: string;
  status: "draft" | "published" | "modified";
  publishedAt: string | null;
  slug: string;
  spaceSlug?: string | null;
  publishAt?: string | null;
  scheduleError?: string | null;
}

export type WikiAnswer<T = { data: WikiDto }> = Answer<T>;

export interface WikiApi {
  createSpace(caller: Caller, data: Record<string, unknown>, query?: string): Promise<WikiAnswer>;
  updateSpace(
    caller: Caller,
    documentId: string,
    data: Record<string, unknown>,
    version?: string | number | null,
  ): Promise<WikiAnswer>;
  deleteSpace(
    caller: Caller,
    documentId: string,
    version?: string | number | null,
  ): Promise<WikiAnswer<Record<string, never>>>;
  createPage(
    caller: Caller,
    data: Record<string, unknown>,
    status?: string | null,
  ): Promise<WikiAnswer>;
  updatePage(
    caller: Caller,
    documentId: string,
    data: Record<string, unknown>,
    options?: { status?: string | null; version?: string | number | null },
  ): Promise<WikiAnswer>;
  createDraft(caller: Caller, data: Record<string, unknown>): Promise<WikiAnswer>;
  saveDraft(
    caller: Caller,
    documentId: string,
    data: Record<string, unknown>,
    version?: string | number | null,
  ): Promise<WikiAnswer>;
  action(
    caller: Caller,
    documentId: string,
    action: "publish" | "unpublish" | "discard-draft",
    version?: string | number | null,
  ): Promise<WikiAnswer>;
  removePage(
    caller: Caller,
    documentId: string,
    version?: string | number | null,
  ): Promise<WikiAnswer<Record<string, never>>>;
  editable<T = Record<string, unknown>>(
    caller: Caller,
    plural: "wiki-pages" | "wiki-spaces",
    documentId: string,
  ): Promise<WikiAnswer<{ data: T & { version: string } }>>;
  list<T = Record<string, unknown>>(
    caller: Caller,
    plural: "wiki-pages" | "wiki-spaces",
    query?: string,
  ): Promise<WikiAnswer<{ data: T[]; meta: { pagination: { total: number } } }>>;
  myDrafts<T = Record<string, unknown>>(caller: Caller): Promise<WikiAnswer<{ data: T[] }>>;
  revisions<T = Record<string, unknown>>(
    caller: Caller,
    documentId: string,
    query?: string,
  ): Promise<WikiAnswer<{ data: T[]; meta: { pagination: { total: number } } }>>;
  revision<T = Record<string, unknown>>(
    caller: Caller,
    documentId: string,
    revisionId: number | string,
  ): Promise<WikiAnswer<{ data: T }>>;
  restore(
    caller: Caller,
    documentId: string,
    revisionId: unknown,
    version?: string | number | null,
  ): Promise<WikiAnswer>;
}

export function wikiApi(t: TestStrapi): WikiApi {
  return {
    createSpace: (caller, data, query = "") =>
      t.api(caller, `/api/wiki-spaces${query}`, { json: { data } }),
    updateSpace: (caller, documentId, data, version) =>
      t.api(caller, `/api/wiki-spaces/${documentId}`, {
        method: "PUT",
        headers: ifMatch(version),
        json: { data },
      }),
    deleteSpace: (caller, documentId, version) =>
      t.api(caller, `/api/wiki-spaces/${documentId}`, {
        method: "DELETE",
        headers: ifMatch(version),
      }),
    createPage: (caller, data, status = "published") =>
      t.api(caller, `/api/wiki-pages${status === null ? "" : `?status=${status}`}`, {
        json: { data },
      }),
    updatePage: (caller, documentId, data, options = {}) => {
      const status = options.status === undefined ? "draft" : options.status;
      return t.api(
        caller,
        `/api/wiki-pages/${documentId}${status === null ? "" : `?status=${status}`}`,
        {
          method: "PUT",
          headers: ifMatch(options.version),
          json: { data },
        },
      );
    },
    createDraft: (caller, data) => t.api(caller, "/api/wiki-pages/drafts", { json: { data } }),
    saveDraft: (caller, documentId, data, version) =>
      t.api(caller, `/api/wiki-pages/${documentId}/draft`, {
        method: "PUT",
        headers: ifMatch(version),
        json: { data },
      }),
    action: (caller, documentId, action, version) =>
      t.api(caller, `/api/wiki-pages/${documentId}/${action}`, {
        method: "POST",
        headers: ifMatch(version),
      }),
    removePage: (caller, documentId, version) =>
      t.api(caller, `/api/wiki-pages/${documentId}`, {
        method: "DELETE",
        headers: ifMatch(version),
      }),
    editable: (caller, plural, documentId) =>
      t.api(caller, `/api/${plural}/${documentId}/editable`),
    list: (caller, plural, query = "") =>
      t.api(caller, `/api/${plural}/authoring${query ? `?${query}` : ""}`),
    myDrafts: (caller) => t.api(caller, "/api/wiki-pages/drafts/mine"),
    revisions: (caller, documentId, query = "") =>
      t.api(caller, `/api/wiki-pages/${documentId}/revisions${query ? `?${query}` : ""}`),
    revision: (caller, documentId, revisionId) =>
      t.api(caller, `/api/wiki-pages/${documentId}/revisions/${revisionId}`),
    restore: (caller, documentId, revisionId, version) =>
      t.api(caller, `/api/wiki-pages/${documentId}/restore`, {
        method: "POST",
        headers: ifMatch(version),
        json: { revisionId },
      }),
  };
}

let seq = 0;
const unique = (base: string) => `${base}-${Date.now().toString(36)}-${(seq += 1)}`;

/** A published wiki space, through the Document Service. */
export async function seedSpace(
  t: TestStrapi,
  data: Record<string, unknown> = {},
): Promise<Row & { documentId: string }> {
  const name = (data.name as string | undefined) ?? unique("IT space");
  return (await t.strapi.documents(WIKI_SPACE).create({
    data: { name, slug: unique("it-space"), visibility: "public", ...data },
    status: "published",
  })) as Row & { documentId: string };
}

/** A wiki page through the Document Service (published unless `status` says draft). */
export async function seedPage(
  t: TestStrapi,
  data: Record<string, unknown>,
  status: "draft" | "published" = "published",
): Promise<Row & { documentId: string }> {
  return (await t.strapi.documents(WIKI_PAGE).create({
    data: { title: unique("IT page"), slug: unique("it-page"), ...data },
    status,
  })) as Row & { documentId: string };
}

/** The rows of a document, draft first. */
export async function rowsOf(t: TestStrapi, uid: string, documentId: string): Promise<Row[]> {
  return (await t.strapi.db.query(uid).findMany({
    where: { documentId },
    orderBy: { id: "asc" },
    populate:
      uid === WIKI_PAGE
        ? { parent: { select: ["documentId"] }, space: { select: ["documentId"] } }
        : {},
  })) as Row[];
}

/** The parent documentId of each row of a page (draft first). */
export async function parentsOf(t: TestStrapi, documentId: string): Promise<(string | null)[]> {
  const rows = await rowsOf(t, WIKI_PAGE, documentId);
  return [...rows]
    .sort((a, b) => Number(a.publishedAt != null) - Number(b.publishedAt != null))
    .map((row) => (row.parent as { documentId?: string } | null)?.documentId ?? null);
}

/**
 * Writes a parent link raw (a loop left from before batch 16: an older admin
 * panel or raw SQL; the Document Service refuses one now).
 */
export async function linkParentRaw(t: TestStrapi, childRowId: number, parentRowId: number) {
  const join = (
    (t.strapi.db as unknown as { metadata: { get(uid: string): unknown } }).metadata.get(
      WIKI_PAGE,
    ) as {
      attributes: Record<
        string,
        {
          joinTable: {
            name: string;
            joinColumn: { name: string };
            inverseJoinColumn: { name: string };
          };
        }
      >;
    }
  ).attributes.parent.joinTable;
  await (
    t.strapi.db as unknown as {
      getConnection(table: string): { insert(row: Record<string, unknown>): Promise<unknown> };
    }
  )
    .getConnection(join.name)
    .insert({ [join.joinColumn.name]: childRowId, [join.inverseJoinColumn.name]: parentRowId });
}
