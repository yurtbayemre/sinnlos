import {
  WIKI_PAGE_UID,
  type RelationCheck,
  type RelationCheckName,
  type RelationRef,
  type ResolvedToOne,
  type StrapiDb,
} from "./write-allowlist";

/**
 * Which wiki rows a non-bypass writer may point a page at (FX07).
 *
 * The relation guard (restricted-relations.ts) trusts wiki-page.parent/
 * children and wiki-space.pages because they stay inside one wiki space.
 * These checks keep that true for every content-API write by a caller
 * without the admin_role/editor bypass:
 *   - `space` (create only) must be a space the caller can read,
 *   - `parent` must be a page the caller can read in the SAME space, and
 *     neither the page itself nor one of its descendants,
 *   - an existing page is editable only while it sits in a space the caller
 *     can read (editablePageSpace, used by can-edit-wiki's row gate).
 * Every refusal is the allowlist's generic 400, whether the row does not
 * exist, is hidden, is a draft, or sits in another space.
 *
 * "Can read" follows wiki-visibility: a page is readable through the space
 * it sits in, and these callers read published rows only. Draft & publish
 * makes that per DOCUMENT, not per row: every space and page has a draft row
 * and maybe a published one, and the two can differ (an editor's move that
 * is not published yet). A write links DRAFT rows (the document service
 * connects a draft to the target's draft), and the write response populates
 * from there. So:
 *   - a space is usable when it has a published row and EVERY row of it is
 *     in the caller's visible set,
 *   - a page is a readable parent when it has a published row and EVERY row
 *     of it sits in the expected space, which the caller can read,
 *   - a page is editable when EVERY row of it sits in one space the caller
 *     can read. An author whose page was moved into a space they cannot
 *     read loses the edit right: the update response would otherwise hand
 *     out that space's pages through space.pages, parent and children.
 * Rows are compared by documentId, so a numeric row id and a documentId
 * naming the same document behave the same.
 */

export const WIKI_SPACE_UID = "api::wiki-space.wiki-space";

/** Longer (or looping) parent chains are refused rather than walked. */
export const MAX_ANCESTOR_WALK = 1000;

interface Link {
  id?: number;
  documentId?: string;
}

interface DocumentRow {
  id: number;
  documentId: string;
  publishedAt?: unknown;
  space?: Link | null;
  parent?: Link | null;
}

export interface WikiWriteScope {
  /** Row ids of every wiki-space row the caller can read (visibleWikiSpaceIds). */
  visibleSpaceIds: ReadonlySet<number>;
  /** Update only: the page being written. */
  pageDocumentId?: string;
  /** Update only: the space that page sits in (editablePageSpace). */
  spaceDocumentId?: string;
}

const isPublished = (row: DocumentRow) => row.publishedAt !== null && row.publishedAt !== undefined;

const asRows = (rows: unknown): DocumentRow[] => (Array.isArray(rows) ? rows : []);

async function documentIdOf(
  strapi: StrapiDb,
  uid: string,
  ref: RelationRef,
): Promise<string | null> {
  if ("documentId" in ref) return ref.documentId;
  const row = (await strapi.db.query(uid).findOne({
    where: { id: ref.id },
    select: ["id", "documentId"],
  })) as DocumentRow | null;
  return typeof row?.documentId === "string" ? row.documentId : null;
}

async function documentRows(
  strapi: StrapiDb,
  uid: string,
  documentId: string,
  withSpace: boolean,
): Promise<DocumentRow[]> {
  return asRows(
    await strapi.db.query(uid).findMany({
      where: { documentId },
      select: ["id", "documentId", "publishedAt"],
      ...(withSpace ? { populate: { space: { select: ["id", "documentId"] } } } : {}),
    }),
  );
}

/** The one space documentId every row sits in, when every row's space is visible. */
function sharedVisibleSpace(rows: DocumentRow[], visible: ReadonlySet<number>): string | null {
  let shared: string | null = null;
  for (const row of rows) {
    const space = row.space;
    if (!space || typeof space.id !== "number" || typeof space.documentId !== "string") return null;
    if (!visible.has(space.id)) return null;
    if (shared !== null && shared !== space.documentId) return null;
    shared = space.documentId;
  }
  return shared;
}

/**
 * The documentId of the space an existing page sits in, or null when the
 * caller may not edit it through the content API (no space, a space they
 * cannot read, or rows in different spaces).
 */
export async function editablePageSpace(
  strapi: StrapiDb,
  pageDocumentId: string,
  visibleSpaceIds: ReadonlySet<number>,
): Promise<string | null> {
  const rows = await documentRows(strapi, WIKI_PAGE_UID, pageDocumentId, true);
  return sharedVisibleSpace(rows, visibleSpaceIds);
}

async function readableSpace(
  strapi: StrapiDb,
  ref: RelationRef,
  visible: ReadonlySet<number>,
): Promise<string | null> {
  const documentId = await documentIdOf(strapi, WIKI_SPACE_UID, ref);
  if (!documentId) return null;
  const rows = await documentRows(strapi, WIKI_SPACE_UID, documentId, false);
  const usable = rows.some(isPublished) && rows.every((row) => visible.has(row.id));
  return usable ? documentId : null;
}

async function readablePageInSpace(
  strapi: StrapiDb,
  ref: RelationRef,
  spaceDocumentId: string,
  scope: WikiWriteScope,
): Promise<string | null> {
  const documentId = await documentIdOf(strapi, WIKI_PAGE_UID, ref);
  if (!documentId || documentId === scope.pageDocumentId) return null;
  const rows = await documentRows(strapi, WIKI_PAGE_UID, documentId, true);
  if (!rows.some(isPublished)) return null;
  return sharedVisibleSpace(rows, scope.visibleSpaceIds) === spaceDocumentId ? documentId : null;
}

/**
 * True when `ancestor` is one of `start`'s ancestors, following the parent
 * of every row (draft and published) of each page on the way up. A chain
 * longer than MAX_ANCESTOR_WALK counts as true, so it is refused.
 */
async function hasAncestor(strapi: StrapiDb, start: string, ancestor: string): Promise<boolean> {
  const seen = new Set<string>([start]);
  let frontier = [start];
  while (frontier.length > 0) {
    const rows = asRows(
      await strapi.db.query(WIKI_PAGE_UID).findMany({
        where: { documentId: { $in: frontier } },
        select: ["id", "documentId"],
        populate: { parent: { select: ["id", "documentId"] } },
      }),
    );
    const next: string[] = [];
    for (const row of rows) {
      const parent = row.parent?.documentId;
      if (typeof parent !== "string" || seen.has(parent)) continue;
      if (parent === ancestor) return true;
      seen.add(parent);
      next.push(parent);
    }
    if (seen.size > MAX_ANCESTOR_WALK) return true;
    frontier = next;
  }
  return false;
}

/** The relation checks the wiki-page allowlist rules name. */
export function wikiRelationChecks(
  strapi: StrapiDb,
  scope: WikiWriteScope,
): Record<RelationCheckName, RelationCheck> {
  return {
    async wikiSpace(input) {
      if (!input.target || input.disconnect.length > 0) return null;
      const documentId = await readableSpace(strapi, input.target, scope.visibleSpaceIds);
      return documentId ? { target: documentId, disconnect: [] } : null;
    },

    async wikiParent(input, resolved) {
      // Update: the page's own space. Create: the space checked just before.
      const createdIn = resolved.space?.target;
      const spaceDocumentId =
        scope.spaceDocumentId ?? (typeof createdIn === "string" ? createdIn : undefined);
      if (!spaceDocumentId) return null;
      const check = (ref: RelationRef) => readablePageInSpace(strapi, ref, spaceDocumentId, scope);

      let target: ResolvedToOne["target"] = input.target === null ? null : undefined;
      if (input.target) {
        target = await check(input.target);
        if (!target) return null;
        if (scope.pageDocumentId && (await hasAncestor(strapi, target, scope.pageDocumentId))) {
          return null;
        }
      }
      const disconnect: string[] = [];
      for (const ref of input.disconnect) {
        const documentId = await check(ref);
        if (!documentId) return null;
        disconnect.push(documentId);
      }
      return { target, disconnect };
    },
  };
}
