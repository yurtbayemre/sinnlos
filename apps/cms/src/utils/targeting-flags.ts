import { AUDIENCE_DEPARTMENTS } from "@sinnlos/domain";

import { ANNOUNCEMENT_UID, DOCUMENT_UID, EVENT_UID } from "./authoring-uids";
import {
  advanceRevision,
  lockDocument,
  type DocumentLockHost,
  type DocumentRef,
} from "./document-lock";
import {
  affectedDocumentIds,
  POLL_WRITE_ACTIONS,
  type DocumentMiddleware,
  type PollAudienceGuardHost,
} from "./poll-audience-guard";

/**
 * The announcement and event targeting flags, the announcement re-target
 * marker, and the revision advance of the department and team delete hooks
 * (batch 15 lane 15D; decision 06 §B6, §D rule 13, §K 3, §N9). The
 * semantics (contract K10) are in packages/domain/src/audience.ts: the
 * flags and the marker are raised here, by the delete hooks and by the
 * boot backfill, never lowered; "departments" iff linked.
 *
 * THE FLAGS.
 *   - announcement `audience`: "departments" on every row that links a
 *     department or a team. The read rule (D-PT01) hides a "departments"
 *     announcement without either from everyone but moderators, so a row
 *     whose links vanish (an unlink in the admin panel, a delete cascade)
 *     stays restricted instead of turning company-wide;
 *   - event `notifyAudience`: "departments" on every row that links a
 *     department. An event that says "departments" without one notifies
 *     nobody (api/event/content-types/event/lifecycles.ts) instead of the
 *     whole company; it stays readable calendar-wide;
 *   - announcement `retargetRequired` (the marker): set by the department
 *     and team delete hooks on the rows that link the deleted row. The
 *     criteria are AND-combined, so deleting one of them would widen the
 *     audience to whatever remains; with the marker the announcement is
 *     moderator-only until re-targeted (amendment row A3).
 *
 * WRITE-TIME GUARD. `createTargetingFlagsGuard` is the middleware the
 * department/targeting guard slot (bootstrap/document-middlewares.ts, slot
 * 3b, `createDepartmentAudienceGuard`) runs for announcements and events:
 * the poll guard's mechanics (utils/poll-audience-guard.ts, which see for
 * the Strapi 5.57 details). It opens a transaction (it joins the document
 * lock's), runs the writing action inside it, then raises the flag on every
 * row of the affected documents, draft and published alike, that links a
 * target and is not flagged yet, with `updateMany` (`updatedAt`
 * untouched, so the panel keeps showing Published), and patches the
 * action's result so the admin form and the API response show the stored
 * flag. A failing flag write rolls the action back. Every copy a publish
 * or a "Discard changes" takes of a linked row therefore already says
 * "departments" (batch 12 review B12-01, the same reasoning as for
 * documents and quick links).
 *
 * NEVER WIDENS. The guard only ever writes "departments", only on rows that
 * link a target. Removing every department of an event or the department
 * and team of an announcement in the admin panel no longer makes it
 * company-wide on its own: the moderator sets Audience (or Notify
 * audience) to `all` explicitly, a deliberate break-glass edit (release
 * note 8). The authoring allowlist (lane 15A) re-derives the flag only
 * from a payload that carries a targeting key.
 *
 * DELETE HOOKS (§D rule 13, amendment rows A2 and A3). Before the cascade,
 * inside the delete's transaction (the hook joins the Document Service's;
 * a delete outside any transaction is refused, see below):
 *   1. lock the deleted department or team rows `FOR UPDATE` on Postgres
 *      (no link to them can commit around the scan: an insert of a link
 *      row takes `FOR KEY SHARE` on the target row, so it either commits
 *      before the lock and is seen, or waits and then fails the foreign
 *      key check; the CONCURRENT LINKS note of department-delete-restrict.ts);
 *   2. before any other write, lock the revision of every announcement,
 *      event and document that links the deleted row (`ownerDepartment`,
 *      `department`, `departments`, or `team`) and advance it (K2
 *      `lockDocument`/`advanceRevision`), in ascending (uid, documentId)
 *      order after the deleted row's own version row, which the document
 *      lock took first (§G2). A write gate that classified one of these
 *      documents before the delete then fails the revision comparison and
 *      answers 404 or 403 (§N8): the cascade changes ownership and
 *      targeting outside the Document Service;
 *   3. raise the flags and the marker on the linked rows.
 * A failing step fails the delete; a failed delete rolls everything back.
 * A delete outside a transaction (a script's db-level delete) is refused:
 * the query engine opens none around a lifecycle and its DELETE, so a
 * transaction of the hook's own would commit, and release its locks,
 * before the DELETE ran.
 * The flag writes are raw writes that only raise (§G "Rule"); the revision
 * advance covers the cascade's link removal.
 *
 * RESIDUALS. A row linked after the scan by a writer outside the Document
 * Service (raw SQL, a previous cms during a rollback) on SQLite, or one
 * linked without the target row lock, gets its flag from the guard on its
 * next Document Service write but no revision advance (§D rule 13
 * "Residual"). An admin-panel form opened before the delete holds the
 * marker as loaded (false) and sends it back with its next save: the
 * panel is not revision-checked (§G "reverse direction", accepted), so a
 * moderator who saves such a stale form lowers the marker; /manage shows
 * "Needs re-targeting" from the stored state, and the audit trail shows
 * the save.
 */

export const TARGETING_FLAGS_LOG = "[targeting-flags]";

/**
 * Why a department or team delete outside a transaction is refused: the
 * query engine opens none around a lifecycle and its DELETE, so the hook's
 * locks would end before the delete (see the delete hooks below).
 */
export const OUTSIDE_TRANSACTION =
  "refused outside a transaction: the locks, flags and revision advances must commit with " +
  "the delete. Delete through the Document Service (admin panel, API) or inside " +
  "strapi.db.transaction";

/** documentIds per lookup, ids per UPDATE and link rows per page. */
export const TARGETING_FLAGS_PAGE = 200;

/** A content type with a targeting flag the guard raises. */
export interface TargetingFlagType {
  uid: string;
  label: string;
  /** The flag column ("departments" restricts). */
  flag: "audience" | "notifyAudience";
  /** The relations whose presence raises the flag. */
  links: readonly string[];
}

export const ANNOUNCEMENT_TARGETING: TargetingFlagType = {
  uid: ANNOUNCEMENT_UID,
  label: "announcement",
  flag: "audience",
  links: ["department", "team"],
};

export const EVENT_TARGETING: TargetingFlagType = {
  uid: EVENT_UID,
  label: "event",
  flag: "notifyAudience",
  links: ["departments"],
};

/** The types the write-time guard covers. */
export const TARGETING_FLAG_TYPES: readonly TargetingFlagType[] = [
  ANNOUNCEMENT_TARGETING,
  EVENT_TARGETING,
];

/** The relations to a deleted department whose documents get a revision advance. */
export const DEPARTMENT_LINKED_DOCUMENTS: readonly { uid: string; attributes: string[] }[] = [
  { uid: ANNOUNCEMENT_UID, attributes: ["department", "ownerDepartment"] },
  { uid: EVENT_UID, attributes: ["departments", "ownerDepartment"] },
  { uid: DOCUMENT_UID, attributes: ["departments", "ownerDepartment"] },
];

/** The relations to a deleted team whose documents get a revision advance. */
export const TEAM_LINKED_DOCUMENTS: readonly { uid: string; attributes: string[] }[] = [
  { uid: ANNOUNCEMENT_UID, attributes: ["team"] },
];

interface FlagQuery {
  findMany(params: Record<string, unknown>): Promise<unknown>;
  updateMany(params: Record<string, unknown>): Promise<{ count?: number } | undefined>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const listOf = (rows: unknown): unknown[] => (Array.isArray(rows) ? rows : []);

/** The numeric values of `key` in `rows`, in order. */
const numbers = (rows: unknown, key: string): number[] =>
  listOf(rows)
    .map((row) => (isRecord(row) ? row[key] : undefined))
    .filter((value): value is number => typeof value === "number");

/** A populated relation is linked when it holds a row (to-one) or any row (to-many). */
const isLinked = (value: unknown): boolean =>
  Array.isArray(value) ? value.length > 0 : isRecord(value);

/** Rows not flagged yet: the flag is NULL or anything but "departments". */
const unflagged = (flag: string) => [
  { [flag]: { $null: true } },
  { [flag]: { $ne: AUDIENCE_DEPARTMENTS } },
];

/**
 * Raises `flag` to "departments" (and, with `marker`, `retargetRequired` to
 * true) on those of `ids` that are not raised yet, in chunks. Never
 * lowers: the where only matches rows that lack a raise, and the data only
 * holds the raised values. Returns the number of rows changed.
 */
export async function raiseTargetingFlags(
  query: Pick<FlagQuery, "updateMany">,
  flag: TargetingFlagType["flag"],
  ids: readonly number[],
  options: { marker?: boolean } = {},
): Promise<number> {
  let changed = 0;
  for (let start = 0; start < ids.length; start += TARGETING_FLAGS_PAGE) {
    const chunk = ids.slice(start, start + TARGETING_FLAGS_PAGE);
    const pending = options.marker
      ? [
          ...unflagged(flag),
          { retargetRequired: { $null: true } },
          { retargetRequired: { $ne: true } },
        ]
      : unflagged(flag);
    const result = await query.updateMany({
      where: { id: { $in: chunk }, $or: pending },
      data: options.marker
        ? { [flag]: AUDIENCE_DEPARTMENTS, retargetRequired: true }
        : { [flag]: AUDIENCE_DEPARTMENTS },
    });
    changed += result?.count ?? 0;
  }
  return changed;
}

/**
 * Raises the flag on every row (draft and published) of the given
 * documents of `type` that links a target and is not flagged yet. Returns
 * the ids of the rows it flagged. The links come from populates (queries
 * of their own), so the row select joins nothing.
 */
export async function flagLinkedTargetingRows(
  strapi: { db: { query(uid: string): FlagQuery } },
  type: TargetingFlagType,
  documentIds: readonly string[],
): Promise<number[]> {
  const query = strapi.db.query(type.uid);
  const populate = Object.fromEntries(type.links.map((link) => [link, { select: ["id"] }]));
  const toFlag: number[] = [];
  for (let start = 0; start < documentIds.length; start += TARGETING_FLAGS_PAGE) {
    const chunk = documentIds.slice(start, start + TARGETING_FLAGS_PAGE);
    const rows = listOf(
      await query.findMany({
        where: { documentId: { $in: chunk } },
        select: ["id", type.flag],
        populate,
      }),
    );
    for (const row of rows) {
      if (!isRecord(row) || typeof row.id !== "number") continue;
      const linked = type.links.some((link) => isLinked(row[link]));
      if (linked && row[type.flag] !== AUDIENCE_DEPARTMENTS) toFlag.push(row.id);
    }
  }
  if (toFlag.length > 0) await raiseTargetingFlags(query, type.flag, toFlag);
  return toFlag;
}

/** Shows the stored flag in the action's result (a row, or `{ entries }`). */
function patchResult(result: unknown, flag: string, flagged: ReadonlySet<number>): void {
  if (!isRecord(result)) return;
  const rows: unknown[] = Array.isArray(result.entries) ? result.entries : [result];
  for (const row of rows) {
    if (isRecord(row) && typeof row.id === "number" && flagged.has(row.id) && flag in row) {
      row[flag] = AUDIENCE_DEPARTMENTS;
    }
  }
}

/**
 * The write-time guard for announcements and events (see the header):
 * every writing action of the Document Service on either type runs in a
 * transaction, and the linked rows of the affected documents come out
 * flagged. Other types, reads and deletes pass through untouched.
 */
export function createTargetingFlagsGuard(strapi: PollAudienceGuardHost): DocumentMiddleware {
  return async (context, next) => {
    const action = context.action ?? "";
    const type = TARGETING_FLAG_TYPES.find((candidate) => candidate.uid === context.uid);
    if (!type || !POLL_WRITE_ACTIONS.includes(action)) return next();
    return strapi.db.transaction(async () => {
      const result = await next();
      const documentIds = affectedDocumentIds(context.params, result);
      const flagged = await flagLinkedTargetingRows(strapi, type, documentIds);
      if (flagged.length > 0) {
        patchResult(result, type.flag, new Set(flagged));
        strapi.log.info(
          `${TARGETING_FLAGS_LOG} ${type.label} ${action}: set the ${type.flag} of ` +
            `${flagged.length} ${type.label} row(s) to '${AUDIENCE_DEPARTMENTS}' (they link a target)`,
        );
      }
      return result;
    });
  };
}

// ---------------------------------------------------------------------------
// The delete hooks.

/** A `<type>_<attribute>_lnk` table as the query engine knows it. */
export interface RelationLinkTable {
  uid: string;
  rowColumn: string;
  targetColumn: string;
}

/** The query builder slice that locks rows (Postgres). */
interface LockQuery {
  select(columns: string[]): LockQuery;
  where(where: Record<string, unknown>): LockQuery;
  forUpdate(): LockQuery;
  execute(): Promise<unknown>;
}

/** The slice of the Strapi instance the delete hooks use. */
export interface TargetingDeleteHost extends DocumentLockHost {
  // Own members first: an intersection of methods resolves like overloads.
  db: {
    query(uid: string): FlagQuery & {
      findOne(params: Record<string, unknown>): Promise<Record<string, unknown> | null>;
    };
    queryBuilder(uid: string): LockQuery;
    dialect: { client: string };
  } & DocumentLockHost["db"];
  log: { info(message: string): void };
}

/**
 * The link table of `<uid>.<attribute>` (every relation of Strapi 5 has
 * one: @strapi/database metadata `joinTable`), or a thrown error (fail
 * closed) that ends with `refusal`.
 */
export function relationLinkTable(
  strapi: { db: { metadata: { get(uid: string): unknown } } },
  uid: string,
  attribute: string,
  refusal: string,
): RelationLinkTable {
  const field = (value: unknown, key: string): unknown =>
    isRecord(value) ? value[key] : undefined;
  const joinTable = field(
    field(field(strapi.db.metadata.get(uid), "attributes"), attribute),
    "joinTable",
  );
  const table = field(joinTable, "name");
  const rowColumn = field(field(joinTable, "joinColumn"), "name");
  const targetColumn = field(field(joinTable, "inverseJoinColumn"), "name");
  if (!isName(table) || !isName(rowColumn) || !isName(targetColumn)) {
    throw new Error(
      `${TARGETING_FLAGS_LOG} the link table of ${uid}.${attribute} is unknown; ${refusal}`,
    );
  }
  return { uid: table, rowColumn, targetColumn };
}

/**
 * The ids of the rows of `targetUid` the delete's `where` matches (none =
 * every row, as for an unfiltered deleteMany), read in id pages; on
 * Postgres each page is locked `FOR UPDATE` in the ambient transaction
 * (see the header, step 1).
 */
export async function lockMatchedRows(
  strapi: Pick<TargetingDeleteHost, "db">,
  targetUid: string,
  where: Record<string, unknown> | null | undefined,
): Promise<number[]> {
  const filter = where != null && Object.keys(where).length > 0 ? where : null;
  const all: number[] = [];
  let afterId = 0;
  for (;;) {
    const page = { id: { $gt: afterId } };
    const ids = numbers(
      await strapi.db.query(targetUid).findMany({
        where: filter ? { $and: [filter, page] } : page,
        select: ["id"],
        orderBy: { id: "asc" },
        limit: TARGETING_FLAGS_PAGE,
      }),
      "id",
    );
    if (ids.length > 0 && strapi.db.dialect.client === "postgres") {
      await strapi.db
        .queryBuilder(targetUid)
        .select(["id"])
        .where({ id: { $in: ids } })
        .forUpdate()
        .execute();
    }
    all.push(...ids);
    if (ids.length < TARGETING_FLAGS_PAGE) return all;
    afterId = ids[ids.length - 1];
  }
}

/** The ids of the rows of the link table's owner that link any of `targetIds`. */
async function rowIdsLinking(
  strapi: Pick<TargetingDeleteHost, "db">,
  link: RelationLinkTable,
  targetIds: readonly number[],
): Promise<number[]> {
  const rowIds = new Set<number>();
  const links = strapi.db.query(link.uid);
  for (let start = 0; start < targetIds.length; start += TARGETING_FLAGS_PAGE) {
    const targets = targetIds.slice(start, start + TARGETING_FLAGS_PAGE);
    let afterLinkId = 0;
    for (;;) {
      const page = await links.findMany({
        where: { [link.targetColumn]: { $in: targets }, id: { $gt: afterLinkId } },
        select: ["id", link.rowColumn],
        orderBy: { id: "asc" },
        limit: TARGETING_FLAGS_PAGE,
      });
      for (const id of numbers(page, link.rowColumn)) rowIds.add(id);
      const linkIds = numbers(page, "id");
      if (linkIds.length < TARGETING_FLAGS_PAGE) break;
      afterLinkId = linkIds[linkIds.length - 1];
    }
  }
  return [...rowIds].sort((a, b) => a - b);
}

/** A document whose revision a delete hook advances (the document lock's ref). */
export type { DocumentRef };

/** Ascending (uid, documentId): the one order every multi-document lock takes (§G2). */
export const compareDocumentRefs = (a: DocumentRef, b: DocumentRef): number =>
  a.uid < b.uid
    ? -1
    : a.uid > b.uid
      ? 1
      : a.documentId < b.documentId
        ? -1
        : a.documentId > b.documentId
          ? 1
          : 0;

/**
 * The documents of `relations` that link any of `targetIds` (both rows of
 * a document count), sorted ascending and without duplicates.
 */
export async function documentsLinking(
  strapi: Pick<TargetingDeleteHost, "db">,
  relations: readonly { uid: string; attributes: readonly string[] }[],
  targetIds: readonly number[],
  refusal: string,
): Promise<DocumentRef[]> {
  // Every link table first: an unknown one refuses the delete before any read.
  const tables = relations.flatMap(({ uid, attributes }) =>
    attributes.map((attribute) => ({
      uid,
      link: relationLinkTable(strapi, uid, attribute, refusal),
    })),
  );
  const seen = new Set<string>();
  const refs: DocumentRef[] = [];
  if (targetIds.length === 0) return refs;
  for (const { uid, link } of tables) {
    const rowIds = await rowIdsLinking(strapi, link, targetIds);
    for (let start = 0; start < rowIds.length; start += TARGETING_FLAGS_PAGE) {
      const rows = await strapi.db.query(uid).findMany({
        where: { id: { $in: rowIds.slice(start, start + TARGETING_FLAGS_PAGE) } },
        select: ["id", "documentId"],
      });
      for (const row of listOf(rows)) {
        const documentId = isRecord(row) ? row.documentId : undefined;
        if (!isName(documentId)) continue;
        const key = `${uid}\u0000${documentId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ uid, documentId });
      }
    }
  }
  return refs.sort(compareDocumentRefs);
}

/**
 * Locks and advances the revision of each document, in the given
 * (ascending) order. Inside a transaction (K2). Returns how many.
 */
export async function advanceRevisionsOf(
  strapi: DocumentLockHost,
  refs: readonly DocumentRef[],
): Promise<number> {
  for (const { uid, documentId } of refs) {
    await lockDocument(strapi, uid, documentId);
    await advanceRevision(strapi, uid, documentId);
  }
  return refs.length;
}

/**
 * Raises the announcement `audience` and the `retargetRequired` marker on
 * every announcement row whose `relation` (department or team) is one of
 * `targetIds`. Returns the rows changed.
 */
export async function markAnnouncementsLinking(
  strapi: Pick<TargetingDeleteHost, "db">,
  relation: "department" | "team",
  targetIds: readonly number[],
  refusal: string,
): Promise<number> {
  if (targetIds.length === 0) return 0;
  const link = relationLinkTable(strapi, ANNOUNCEMENT_UID, relation, refusal);
  const rowIds = await rowIdsLinking(strapi, link, targetIds);
  return raiseTargetingFlags(strapi.db.query(ANNOUNCEMENT_UID), "audience", rowIds, {
    marker: true,
  });
}

/**
 * Raises the event `notifyAudience` on every event row that links one of
 * `departmentIds`. Returns the rows changed.
 */
export async function flagEventsLinking(
  strapi: Pick<TargetingDeleteHost, "db">,
  departmentIds: readonly number[],
  refusal: string,
): Promise<number> {
  if (departmentIds.length === 0) return 0;
  const link = relationLinkTable(strapi, EVENT_UID, "departments", refusal);
  const rowIds = await rowIdsLinking(strapi, link, departmentIds);
  return raiseTargetingFlags(strapi.db.query(EVENT_UID), "notifyAudience", rowIds);
}
