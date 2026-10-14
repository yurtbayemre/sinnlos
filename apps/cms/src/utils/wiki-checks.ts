import { FORM_KEY } from "@sinnlos/domain";
import { errors } from "@strapi/utils";

import { WIKI_PAGE_UID, WIKI_SPACE_UID } from "./authoring-uids";
import {
  MUTATING_ACTIONS,
  type DocumentActionMiddleware,
  type DocumentLockHost,
} from "./document-lock";
import { relationLinkTable } from "./targeting-flags";
import { lockWikiStructure } from "./wiki-structure-lock";
import { parseToOneRelation, refuseKeys } from "./write-allowlist";

/**
 * The wiki checks (deep-dive plan batch 16, S2 and S15; lane 16B item 5):
 * Document Service middleware slot 4 (bootstrap/document-middlewares.ts),
 * inside the document lock's transaction, for EVERY source (content API,
 * Content Manager single and bulk, the scheduler, boot writers).
 *
 * PARENT LOOPS. Every mutating wiki-page action (create, update, clone,
 * publish, unpublish, discardDraft, delete) takes the wiki structure lock
 * (utils/wiki-structure-lock.ts), reads the DOCUMENT-LEVEL parent graph
 * (every row's parent link, both ends mapped to their documentId and
 * de-duplicated: the graph a reader walks), runs the action, and reads it
 * again. For every edge `u → v` (u's parent is v) the action ADDED, it
 * refuses when u is reachable from v afterwards: a loop through the new
 * edge. The refusal is a 400 `ValidationError` with `details.keys:
 * ["parent"]` and `details.codes.parent = "parentCycle"`, and the whole
 * action rolls back.
 *   - Why every action: publish and discard re-create the incoming
 *     self-referential links of OTHER pages (@strapi/core 5.57
 *     document-service repository.js, utils/self-referential-relations.js),
 *     so they can add edges, and a concurrent parent change could close a
 *     loop with them.
 *   - Why an edge diff: removed and unchanged edges never refuse, so a
 *     diamond (a page whose draft and published rows have different
 *     parents that meet again), two twins with one parent, a loop that
 *     existed before (legacy, or the admin panel of an older batch) and
 *     the repair of such a loop all pass. Payload shapes never need
 *     parsing (the panel's connect/disconnect/set, the API's set): the
 *     check reads what was written.
 *   - The whole edge set is read, because an action can add edges of other
 *     pages; at intranet scale that is a few hundred link rows, read twice
 *     under the lock, and the walk is in memory.
 *
 * THE PAGE'S SPACE. A create, update or clone whose payload names a space
 * must leave the page's draft linked to one: a space deleted between the
 * write's checks and its insert (both now under the structure lock) answers
 * `invalid` on `space`. The space it names is looked up under the lock
 * before the action, so a delete that won the lock answers that same
 * refusal, not Strapi's own `Document with id "…" not found` without keys
 * (the batch 16 staging rehearsal).
 *
 * SPACES. Every mutating wiki-space action takes the structure lock too.
 * A publish (also a create or update with `status: published`) deletes the
 * space's published row and re-creates it, re-linking the page rows it
 * loaded BEFORE the delete (@strapi/core 5.57 repository.js publish,
 * utils/bidirectional-relations.js); a page published in between would
 * lose its space link with the delete's cascade (Codex re-review of lane
 * 16B). Under the lock no page write runs in that window.
 *
 * NON-EMPTY SPACES (S15). A delete, an unpublish and a discard of a space
 * without a published row (it deletes the space) refuse with `_form:
 * spaceNotEmpty` while any page row links any row of the space: a space's
 * pages would otherwise lose their space (a panel unpublish deletes the
 * published row, its pages' links cascade, and a republish does not
 * re-link them). A discard of a space WITH a published row rebuilds the
 * draft row from it, and Strapi 5.57 re-links only the pages that have a
 * published version (Codex review of lane 16B, reproduced on both
 * engines): a draft-only page would lose its space, and with it its
 * author's access. So every page row that linked the space before must
 * link it after, else the discard refuses (`spaceNotEmpty`) and rolls
 * back.
 *
 * RESERVED SLUGS: a page slug `new` and a space slug `drafts` are refused
 * (`invalid` on `slug`): the web's routes use them as words.
 *
 * REVISION LINKS (batch 16.1, issue #81): a page's history is written by
 * the wiki-page lifecycle alone (the revision's `page` link and its
 * `pageDocumentId` anchor, utils/wiki-revisions.ts). Since wiki revisions
 * lost draft & publish (batch 16 lane 16D) the admin panel's relation
 * field on the page form lists them, and its connect and disconnect would
 * move or unlink revisions; the form no longer shows the field
 * (wiki-page schema `config.attributes.revisions.hidden`), and a
 * create, update or clone whose `revisions` would change any link is
 * refused here (`details.keys: ["revisions"]`), for every source. The
 * panel's untouched relation value `{ connect: [], disconnect: [] }`
 * passes. The content API refuses the key earlier (the allowlist). A
 * clone gets `revisions: { set: [] }`: Strapi copies every relation a
 * clone's payload leaves out, which would move the source's revisions to
 * the copy.
 *
 * LOCK ORDER (K21): the document's own version row (slot 2) first, then the
 * structure row; nothing here locks a document row afterwards.
 */

/** The wiki-space actions that can remove the space's rows (the emptiness checks). */
const SPACE_REMOVAL_ACTIONS: readonly string[] = ["delete", "unpublish", "discardDraft"];

/** The actions whose payload the checks read (a reserved slug; a page's space and revisions). */
const PAYLOAD_ACTIONS: readonly string[] = ["create", "update", "clone"];

/**
 * Slugs the web's routes use as words (lane 16C): `/wiki/<space>/new`
 * (a new page) and `/wiki/drafts` (the caller's drafts). The content API
 * never derives them (uniqueSlugFrom appends a random suffix); the admin
 * panel, which sets slugs freely, is refused them here.
 */
export const RESERVED_WIKI_SLUGS: Readonly<Record<string, readonly string[]>> = {
  [WIKI_PAGE_UID]: ["new"],
  [WIKI_SPACE_UID]: ["drafts"],
};

/** The slice of the Strapi instance the checks use (own members first: they resolve first). */
export type WikiChecksHost = {
  db: {
    query(uid: string): {
      findOne(params: Record<string, unknown>): Promise<Record<string, unknown> | null>;
      findMany(params: Record<string, unknown>): Promise<unknown>;
      count(params: Record<string, unknown>): Promise<number>;
    };
  };
} & DocumentLockHost;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const listOf = (rows: unknown): unknown[] => (Array.isArray(rows) ? rows : []);

const isDocumentId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const rowId = (value: unknown): number | null => {
  const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
};

// ---------------------------------------------------------------------------
// The edge diff (pure).

/** A document-level parent edge: `child`'s parent is `parent` (documentIds). */
export type ParentEdge = readonly [child: string, parent: string];

const keyOf = ([child, parent]: ParentEdge) => `${child}\u0000${parent}`;

/** The edges of `after` that `before` does not hold (de-duplicated). */
export function addedEdges(
  before: Iterable<ParentEdge>,
  after: Iterable<ParentEdge>,
): ParentEdge[] {
  const known = new Set([...before].map(keyOf));
  const added = new Map<string, ParentEdge>();
  for (const edge of after) {
    const key = keyOf(edge);
    if (!known.has(key)) added.set(key, edge);
  }
  return [...added.values()];
}

/**
 * The first of `added` that lies on a loop of `edges` (its child is
 * reachable from its parent along parent edges), or null. A self-edge is a
 * loop. The walk is in memory and visits each document once per edge.
 */
export function loopThrough(
  edges: Iterable<ParentEdge>,
  added: readonly ParentEdge[],
): ParentEdge | null {
  const parents = new Map<string, Set<string>>();
  for (const [child, parent] of edges) {
    const set = parents.get(child) ?? new Set<string>();
    set.add(parent);
    parents.set(child, set);
  }
  for (const edge of added) {
    const [child, parent] = edge;
    const seen = new Set<string>([parent]);
    const stack = [parent];
    while (stack.length > 0) {
      const node = stack.pop() as string;
      if (node === child) return edge;
      for (const next of parents.get(node) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
  }
  return null;
}

/** Whether a page payload points the page at a space (any relation shape naming a target). */
export function namesSpace(data: unknown): boolean {
  if (!isRecord(data) || !("space" in data)) return false;
  const value = data.space;
  if (value === null || value === undefined) return false;
  if (typeof value === "number" || typeof value === "string") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (!isRecord(value)) return false;
  if ("id" in value || "documentId" in value) return true;
  const named = (list: unknown) => (Array.isArray(list) ? list.length > 0 : list != null);
  return named(value.set) || named(value.connect);
}

/**
 * Whether a page payload's `revisions` would change any revision link. The
 * admin panel's form sends every relation as `{ connect: [], disconnect:
 * [] }` when it is left alone; that, `{}` and no key change nothing. On a
 * new document (`create`, `clone`) an empty set changes nothing either:
 * the Content Manager's clone sets `revisions: { set: [] }` for a role
 * whose create permission leaves the field out (excludeNotCreatableFields,
 * Codex re-review). Every other value (a list of revisions, an id, null,
 * an empty set on an update, a non-empty set, connect or disconnect)
 * would set, move or unlink revisions.
 */
export function changesRevisionLinks(data: unknown, newDocument = false): boolean {
  if (!isRecord(data) || data.revisions === undefined) return false;
  const value = data.revisions;
  const empty = (entry: unknown) => Array.isArray(entry) && entry.length === 0;
  if (!isRecord(value)) return !(newDocument && empty(value));
  const inertWhenEmpty = newDocument ? ["connect", "disconnect", "set"] : ["connect", "disconnect"];
  return Object.entries(value).some(
    ([key, entry]) => entry !== undefined && !(inertWhenEmpty.includes(key) && empty(entry)),
  );
}

// ---------------------------------------------------------------------------
// The refusals.

/** The refusal of a page write that would link or unlink revisions (key `revisions`). */
export function revisionLinksError(): InstanceType<typeof errors.ValidationError> {
  return new errors.ValidationError(
    "A page's history is recorded by the wiki: its revisions cannot be linked or unlinked",
    { keys: ["revisions"] },
  );
}

/** The `parentCycle` refusal (key `parent`). */
export function parentCycleError(): InstanceType<typeof errors.ValidationError> {
  return new errors.ValidationError("A page cannot be placed below itself or one of its subpages", {
    keys: ["parent"],
    codes: { parent: "parentCycle" },
  });
}

/** The `spaceNotEmpty` refusal (key `_form`). */
export function spaceNotEmptyError(): InstanceType<typeof errors.ValidationError> {
  return new errors.ValidationError("This space still has pages", {
    keys: [FORM_KEY],
    codes: { [FORM_KEY]: "spaceNotEmpty" },
  });
}

/** The refusal of a space discard that would take pages out of the space (`spaceNotEmpty`). */
export function spaceDiscardError(): InstanceType<typeof errors.ValidationError> {
  return new errors.ValidationError(
    "Discarding this space's draft would take its unpublished pages out of the space",
    { keys: [FORM_KEY], codes: { [FORM_KEY]: "spaceNotEmpty" } },
  );
}

// ---------------------------------------------------------------------------
// The reads (inside the action's transaction: the query engine joins it).

const REFUSAL = "the wiki checks refuse the write";

/** Every document-level parent edge of the wiki. */
export async function readParentEdges(strapi: WikiChecksHost): Promise<ParentEdge[]> {
  const link = relationLinkTable(strapi, WIKI_PAGE_UID, "parent", REFUSAL);
  const links = listOf(
    await strapi.db.query(link.uid).findMany({ select: [link.rowColumn, link.targetColumn] }),
  );
  if (links.length === 0) return [];
  const pages = listOf(
    await strapi.db.query(WIKI_PAGE_UID).findMany({ select: ["id", "documentId"] }),
  );
  const documentOf = new Map<number, string>();
  for (const page of pages) {
    if (isRecord(page) && typeof page.id === "number" && isDocumentId(page.documentId)) {
      documentOf.set(page.id, page.documentId);
    }
  }
  const edges = new Map<string, ParentEdge>();
  for (const row of links) {
    if (!isRecord(row)) continue;
    const child = documentOf.get(rowId(row[link.rowColumn]) ?? -1);
    const parent = documentOf.get(rowId(row[link.targetColumn]) ?? -1);
    if (!child || !parent) continue;
    const edge: ParentEdge = [child, parent];
    edges.set(keyOf(edge), edge);
  }
  return [...edges.values()];
}

/** The page rows (ids) that link any row of the space `documentId`. */
export async function pageRowsInSpace(
  strapi: WikiChecksHost,
  documentId: string,
): Promise<number[]> {
  const spaceRows = listOf(
    await strapi.db.query(WIKI_SPACE_UID).findMany({ where: { documentId }, select: ["id"] }),
  )
    .map((row) => (isRecord(row) ? rowId(row.id) : null))
    .filter((id): id is number => id !== null);
  if (spaceRows.length === 0) return [];
  const link = relationLinkTable(strapi, WIKI_PAGE_UID, "space", REFUSAL);
  const links = listOf(
    await strapi.db
      .query(link.uid)
      .findMany({ where: { [link.targetColumn]: { $in: spaceRows } }, select: [link.rowColumn] }),
  );
  return [
    ...new Set(
      links
        .map((row) => (isRecord(row) ? rowId(row[link.rowColumn]) : null))
        .filter((id): id is number => id !== null),
    ),
  ].sort((a, b) => a - b);
}

/** Whether any page row links any row of the space `documentId`. */
export async function spaceHasPages(strapi: WikiChecksHost, documentId: string): Promise<boolean> {
  return (await pageRowsInSpace(strapi, documentId)).length > 0;
}

/** Whether the draft row of page `documentId` links a space. */
async function draftHasSpace(strapi: WikiChecksHost, documentId: string): Promise<boolean> {
  const draft = await strapi.db.query(WIKI_PAGE_UID).findOne({
    where: { documentId, publishedAt: { $null: true } },
    select: ["id"],
    populate: { space: { select: ["id"] } },
  });
  return isRecord(draft) && isRecord(draft.space);
}

/**
 * Whether the space a page payload points at still has a row (looked up
 * under the structure lock). A shape this cannot read, or one without a
 * target, is left to Strapi and the after-check.
 */
async function namedSpaceExists(strapi: WikiChecksHost, data: unknown): Promise<boolean> {
  const target = isRecord(data) ? parseToOneRelation(data.space)?.target : undefined;
  if (!target) return true;
  const where = "id" in target ? { id: target.id } : { documentId: target.documentId };
  return (await strapi.db.query(WIKI_SPACE_UID).count({ where })) > 0;
}

/** The document an action writes (create and clone: the new one, from the result). */
function writtenDocumentId(action: string, params: Record<string, unknown>, result: unknown) {
  if (action === "create" || action === "clone") {
    return isRecord(result) && isDocumentId(result.documentId) ? result.documentId : null;
  }
  return isDocumentId(params.documentId) ? params.documentId : null;
}

// ---------------------------------------------------------------------------
// The middleware.

/** The wiki-checks Document Service middleware (see the module comment). */
export function createWikiChecks(strapi: WikiChecksHost): DocumentActionMiddleware {
  return async (context, next) => {
    const uid = context.uid;
    const action = context.action ?? "";
    const params = isRecord(context.params) ? context.params : {};

    const reserved = uid ? RESERVED_WIKI_SLUGS[uid] : undefined;
    if (reserved && PAYLOAD_ACTIONS.includes(action) && isRecord(params.data)) {
      const slug = params.data.slug;
      if (typeof slug === "string" && reserved.includes(slug.trim().toLowerCase())) {
        refuseKeys(["slug"]);
      }
    }

    if (uid === WIKI_PAGE_UID && MUTATING_ACTIONS.includes(action)) {
      if (
        PAYLOAD_ACTIONS.includes(action) &&
        changesRevisionLinks(params.data, action !== "update")
      ) {
        throw revisionLinksError();
      }
      if (action === "clone") {
        // A clone copies every relation its payload leaves out; the
        // revisions' owning side is the revision, so the copy would take
        // them over from the source (Codex review of 16.1, reproduced).
        // The copy starts without history.
        params.data = { ...(isRecord(params.data) ? params.data : {}), revisions: { set: [] } };
      }
      return strapi.db.transaction(async () => {
        await lockWikiStructure(strapi);
        const namesItsSpace = PAYLOAD_ACTIONS.includes(action) && namesSpace(params.data);
        if (namesItsSpace && !(await namedSpaceExists(strapi, params.data))) {
          refuseKeys(["space"]);
        }
        const before = await readParentEdges(strapi);
        const result = await next();
        const after = await readParentEdges(strapi);
        const loop = loopThrough(after, addedEdges(before, after));
        if (loop) throw parentCycleError();
        if (namesItsSpace) {
          const documentId = writtenDocumentId(action, params, result);
          if (!documentId || !(await draftHasSpace(strapi, documentId))) refuseKeys(["space"]);
        }
        return result;
      });
    }

    if (uid === WIKI_SPACE_UID && MUTATING_ACTIONS.includes(action)) {
      const documentId = params.documentId;
      return strapi.db.transaction(async () => {
        await lockWikiStructure(strapi);
        if (!SPACE_REMOVAL_ACTIONS.includes(action) || !isDocumentId(documentId)) return next();
        if (action === "discardDraft") {
          const published = await strapi.db
            .query(WIKI_SPACE_UID)
            .count({ where: { documentId, publishedAt: { $notNull: true } } });
          if (published > 0) {
            // The draft is rebuilt from the published row: every page row
            // that linked the space must still link it afterwards.
            const before = await pageRowsInSpace(strapi, documentId);
            const result = await next();
            const after = new Set(await pageRowsInSpace(strapi, documentId));
            if (before.some((id) => !after.has(id))) throw spaceDiscardError();
            return result;
          }
        }
        if (await spaceHasPages(strapi, documentId)) throw spaceNotEmptyError();
        return next();
      });
    }

    return next();
  };
}
