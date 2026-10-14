/**
 * Wiki page history as AFTER-images (decision 06 §J3, DA03; batch 16 lane
 * 16D, contract K16): every content change of a page's DRAFT row records a
 * wiki-revision with the state it leads to, in the save's own transaction.
 *
 * WHAT IS RECORDED. On `afterCreate` and `afterUpdate` of a draft row
 * (`publishedAt` null) the row is re-read inside the transaction and its
 * title, body and summary go into a new revision: kind `after`,
 * `pageDocumentId` (the anchor, utils/wiki-revisions.ts), the `page` link
 * to the draft row (S19), `publishedAt` set (S4: on a type without draft &
 * publish only the Document Service sets it, and a row without it would make
 * the next boot's guard refuse). A published-row create (a publish copies
 * the draft) records nothing (S5.1, S5.2).
 *
 * WHAT IS SKIPPED:
 *   - an update whose title, body and summary equal the STORED row before
 *     the update, read in `beforeUpdate` and kept in the event state for
 *     this one update (an order-only or relation-only save records nothing,
 *     S5.3). The stored row, not the latest snapshot: a change made while
 *     no lifecycle of this kind ran (a rollback window on batch 15.1) is
 *     then still recorded by the next save that changes the content;
 *   - a create whose content equals the page's latest `after` or `baseline`
 *     revision (a discard rebuilds the draft from the published row, the
 *     boot's draft-twin repair clones it): a clone of another page has no
 *     snapshot yet and records its first one;
 *   - never a RESTORE: a save inside `wikiEditContext` with `restoredFrom`
 *     always records, with `restoredFrom`, even when nothing changed.
 * A summary-only change is recorded. Empty and missing values compare equal.
 *
 * WHO:
 *   - `editor`: the users-permissions user of `wikiEditContext` (the write
 *     paths of lane 16B wrap create and update in it), else the request's
 *     users-permissions caller;
 *   - `adminEditorId`: the admin user of an admin-panel request (the admin
 *     strategy of the request context, as the audit recorder reads it,
 *     utils/audit.ts resolveActor). Not `data.updatedBy`: a discard copies
 *     that from the published row, so it can name an earlier admin;
 *   - neither: a boot write (the seed, the draft-twin repair).
 * The edit note comes from `wikiEditContext.revisionSummary` only (the dead
 * `data.revisionSummary` fallback of DA03 is gone, decision 06 §J3).
 *
 * The insert runs in the save's transaction and is never caught: a failing
 * insert fails the save on both engines (S5.6; architecture Kurzliste
 * "Lifecycles und Transaktionen"). The reads are plain query-engine reads,
 * which join that transaction.
 */
import { resolveActor, type AuditHost } from "../../../../utils/audit";
import { wikiEditContext } from "../../../../utils/wiki-edit-context";
import { WIKI_REVISION_UID, positiveId } from "../../../../utils/wiki-revisions";

const PAGE_UID = "api::wiki-page.wiki-page";

/** The page fields a revision captures, plus what the lifecycle decides by. */
const PAGE_FIELDS = ["id", "documentId", "title", "body", "summary", "publishedAt"];

/** The event-state key of the stored content `beforeUpdate` read. */
const STORED = "wikiRevisionStored";

interface Content {
  title: string;
  body: string;
  summary: string;
}

type Row = Record<string, unknown>;

interface LifecycleEvent {
  params?: { where?: Row; data?: Row };
  result?: unknown;
  state?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const plain = (value: unknown): string => (typeof value === "string" ? value : "");

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** A page row's content; a revision's (`pageSummary`) with `fromRevision`. */
const contentOf = (row: Row, fromRevision = false): Content => ({
  title: plain(row.title),
  body: plain(row.body),
  summary: plain(fromRevision ? row.pageSummary : row.summary),
});

const sameContent = (a: Content, b: Content) =>
  a.title === b.title && a.body === b.body && a.summary === b.summary;

const isDraft = (row: Row) => row.publishedAt === null || row.publishedAt === undefined;

/** The row as it is now, inside the save's transaction. */
async function reread(result: unknown): Promise<Row | null> {
  const id = isRecord(result) ? positiveId(result.id) : null;
  if (id === null) return null;
  const row: unknown = await strapi.db
    .query(PAGE_UID)
    .findOne({ where: { id }, select: PAGE_FIELDS });
  return isRecord(row) && typeof row.documentId === "string" ? row : null;
}

/** The content of the page's latest `after` or `baseline` revision, if any. */
async function latestSnapshot(pageDocumentId: string): Promise<Content | null> {
  const [latest]: unknown[] = await strapi.db.query(WIKI_REVISION_UID).findMany({
    where: { pageDocumentId, kind: { $in: ["after", "baseline"] } },
    select: ["title", "body", "pageSummary"],
    orderBy: { id: "desc" },
    limit: 1,
  });
  return isRecord(latest) ? contentOf(latest, true) : null;
}

/** Writes the after-image of `row` (see the module comment). */
async function record(row: Row, restoredFrom: number | null): Promise<void> {
  const context = wikiEditContext.getStore();
  const actor = resolveActor(strapi as unknown as Pick<AuditHost, "requestContext">, undefined);
  const editorId =
    positiveId(context?.editorId) ?? (actor.actorKind === "user" ? actor.actorUserId : null);
  const adminEditorId = actor.actorKind === "admin" ? actor.actorAdminId : null;
  await strapi.db.query(WIKI_REVISION_UID).create({
    data: {
      page: row.id,
      pageDocumentId: row.documentId,
      title: text(row.title),
      body: text(row.body),
      pageSummary: text(row.summary),
      summary: text(context?.revisionSummary),
      kind: "after",
      editor: editorId,
      adminEditorId,
      restoredFrom,
      publishedAt: new Date(),
    },
  });
}

/**
 * Records the after-image of the draft row `result` names, unless the save
 * is no restore and the row's content equals `stored` (the row before an
 * update) or, without it, the page's latest snapshot.
 */
async function recordAfterImage(result: unknown, stored: Content | undefined): Promise<void> {
  const row = await reread(result);
  if (!row || !isDraft(row)) return;
  const restoredFrom = positiveId(wikiEditContext.getStore()?.restoredFrom);
  if (restoredFrom === null) {
    const before = stored ?? (await latestSnapshot(row.documentId as string));
    if (before && sameContent(before, contentOf(row))) return;
  }
  await record(row, restoredFrom);
}

export default {
  async beforeUpdate(event: LifecycleEvent) {
    const where = event.params?.where;
    if (!isRecord(where) || Object.keys(where).length === 0) return;
    const stored: unknown = await strapi.db.query(PAGE_UID).findOne({ where, select: PAGE_FIELDS });
    if (event.state && isRecord(stored)) event.state[STORED] = contentOf(stored);
  },

  async afterUpdate(event: LifecycleEvent) {
    await recordAfterImage(event.result, event.state?.[STORED] as Content | undefined);
  },

  async afterCreate(event: LifecycleEvent) {
    await recordAfterImage(event.result, undefined);
  },
};
