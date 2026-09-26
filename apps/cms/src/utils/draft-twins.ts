/**
 * Self-healing repair: give every published-only document of a draft &
 * publish type its draft twin (FX38 follow-up for existing databases).
 *
 * Normal Strapi 5 state: a document of a draft & publish type has a DRAFT row
 * and, once published, a PUBLISHED row. The demo seed up to 2026-09-26 wrote
 * those types through `strapi.db.query(...).create({ publishedAt })`: one
 * published row per document and no draft. Strapi 5.55.1 mishandles such
 * documents:
 *   - The Content Manager lists drafts by default (the list has no status,
 *     content-manager dist/server/controllers/validation/dimensions.js:25-26,
 *     and the document service defaults a missing status to draft,
 *     core document-service/repository.js:249, draft-and-publish.js:17-23),
 *     so these documents do not show in the default list.
 *   - Editing one in the admin and publishing it drops relations. The edit
 *     view sends relations as connect/disconnect deltas only
 *     (content-manager dist/admin/pages/EditView/utils/data.js:96-99).
 *     `updateDocument` finds no draft and treats the save as "create a new
 *     document locale" (controllers/collection-types.js:248-267, :277), and
 *     the document service's update() then creates the draft from the request
 *     data alone (repository.js:360-389). Publish deletes the published row
 *     and rebuilds it from that draft (repository.js:448-452): every relation
 *     the form did not touch is gone.
 *   - New drafts cannot link to such a document either: a draft & publish
 *     source links the target's twin of the same status (transform/relations/
 *     utils/dp.js:20-24), and there is no draft twin ("Document with id …
 *     not found", transform/relations/transform/data-ids.js:40-42).
 *
 * The fix uses Strapi's own mechanism: `documents(uid).discardDraft()` on a
 * document without a draft clones its published row into a new draft,
 * relations and media included (repository.js:491-558, entries.js:145-163).
 * It is exactly what Strapi's own "draft & publish switched on" migration does
 * per entry (@strapi/core dist/migrations/draft-publish.js:13-47).
 *
 * ORDER. The clone resolves each relation by documentId to the TARGET's draft
 * twin. A target without a draft yet is silently skipped (`allowMissingId`,
 * entries.js:152, data-ids.js:40). Strapi's migration ignores that and walks
 * the types in registry order; here it matters only for UNIDIRECTIONAL
 * relations between two different draft & publish types, where the target
 * type goes first (planDraftTwinTypes). Everything else lands in any order:
 *   - bidirectional relations (course↔lesson, wiki-space↔wiki-page): the side
 *     cloned second carries the link through its own deep populate, which
 *     includes the inverse (mappedBy) side (utils/populate.js:15-24). The
 *     published rows keep their links: the link-table cleanup spares the
 *     rows of the document's other twin (@strapi/database entity-manager/
 *     regular-relations.js:34-43). The target's DRAFT is a different matter
 *     (PENDING MOVES below);
 *   - self relations (wiki-page parent/children): remapped to whichever twin
 *     exists when either end is cloned (utils/self-referential-relations.js);
 *   - relations to types without draft & publish (users, departments, teams,
 *     media) link the same single row (dp.js:12-16);
 *   - relations FROM types without draft & publish (poll-vote.poll) are
 *     copied onto the new draft as well (utils/unidirectional-relations.js:
 *     69-98), the state Strapi keeps for such links anyway (dp.js:43-48).
 *
 * PENDING MOVES. Cloning the "one" side of a bidirectional one-to-many
 * relation (course.lessons, wiki-space.pages, wiki-page.children; the same
 * holds for a bidirectional one-to-one, which the schemas do not have)
 * attaches the targets' DRAFT rows (dp.js:20-24) and first deletes each of
 * those drafts' link to any other document (entity-manager/index.js:563-577,
 * regular-relations.js:34-43). A pending, unpublished admin edit that moved a
 * lesson to another course, or a page to another space or under another
 * parent, would be moved back. So before the clone, createDraftTwin reads
 * the targets the published row links and refuses the document when one of
 * their drafts links ANOTHER document back: the error names that draft, the
 * transaction rolls back, and the next boot retries once the admin has
 * published or discarded it. A draft without that link is no conflict:
 * re-attaching restores a link that a form-only save (repository.js:373-389)
 * dropped.
 *
 * SKIPPED: api::wiki-revision.wiki-revision. Revisions are append-only
 * snapshots that the wiki-page lifecycle writes as published rows
 * (wiki-page/lifecycles.ts); there is nothing to draft or edit, and every
 * revision in every database is published-only by design (roadmap DA03 plans
 * to turn draft & publish off for it, which would delete any draft rows made
 * here). The lifecycle links a revision to the page row it snapshots, which
 * is the page's draft row in normal operation, so a page's revisions reach
 * its published row on publish. A published-only page only gets revisions
 * from a direct database write to its published row, which nothing in the
 * app does; its new draft has no revision link then (the clone finds no
 * draft revision to point at), and its next publish leaves those revisions
 * without a page link, as an admin publish without this repair does too.
 *
 * SIDE EFFECTS: none of consequence. The only lifecycle that runs is
 * `create` for the new draft row, with `publishedAt` null. Every other write
 * is a raw join-table row: the new draft's own links and, on the "one" side
 * of a one-to-many relation, the link of each target draft to the new draft
 * (PENDING MOVES: only drafts that link no other document). So the
 * announcement and event notification fan-outs (afterCreate/afterUpdate
 * return on a row without publishedAt), the live-events subscriber (reacts to
 * a PUBLISHED announcement create only, utils/live-events.ts) and the wiki
 * revision snapshot (beforeUpdate) stay silent. The lesson validation
 * (beforeCreate) re-checks the copied data, which passed the same check when
 * it was published; a lesson it rejects now is skipped (FAIL-OPEN below).
 * The draft keeps the copied `updatedAt` (@strapi/database lifecycles/
 * subscribers/timestamps.js:12-19 only fills a missing one), so the admin,
 * which compares the two (content-manager services/document-metadata.js:
 * 62-69), shows the document as Published, not Modified. After commit the
 * document service emits `entry.draft-discard` on the event hub
 * (repository.js:553, events.js:44-50); in Community Edition only admin-panel
 * webhooks subscribed to that event listen (services/webhook-runner.js:37).
 *
 * FAIL-OPEN. Missing draft twins are the state these databases have run in
 * all along; they hurt admin editing, not reads. So nothing here ever throws
 * into the boot: a failing document is logged and rolled back (its own
 * transaction), the other documents and types go on, and the next boot
 * retries whatever is still missing. Refusing to boot over it (like the
 * org-dp guard, which prevents data loss) would take the intranet down for an
 * admin-panel defect. Until the failed document has a draft, the drafts of
 * the entries linked to it lack that link (the clone skips a target without
 * a draft), and publishing one of them drops the link from its published row
 * as well (publish rebuilds it from the draft; the old row's link rows
 * cascade). In this app those are the course-lesson, space-page and
 * parent-child page links. The error line says so; the runbook
 * (docs/DEPLOYMENT.md) says to fix the named entry first. Rolling the whole
 * group back instead would leave the other side published-only, where an
 * admin publish drops every link.
 *
 * IDEMPOTENT and BOUNDED. Selection is "published row without a draft row of
 * the same documentId", re-checked inside each document's transaction right
 * before discardDraft (which would otherwise replace an existing draft).
 * The locale only counts for a localized type (pluginOptions.i18n.localized,
 * Strapi's own test in i18n services/content-types.js): for any other type
 * discardDraft ignores the locale and replaces EVERY draft of the document
 * (document-service/internationalization.js:37-40, repository.js:511-521),
 * so a draft in another locale must block the repair as well. No type of
 * this app is localized. Published rows are read in id-ordered pages, and
 * each boot handles at most `maxPerType` documents per type. A steady-state
 * boot costs two small queries per type and page.
 */

export const DRAFT_TWINS_LOG = "[draft-twins]";

/** Draft & publish types that never get a draft twin (see the header). */
export const DRAFT_TWINS_SKIPPED_UIDS: readonly string[] = ["api::wiki-revision.wiki-revision"];

export const DRAFT_TWINS_BATCH_SIZE = 100;
export const DRAFT_TWINS_MAX_PER_TYPE = 1000;

/** The slice of a content-type schema the planner reads. */
export interface DraftTwinAttribute {
  type?: string;
  relation?: string;
  target?: string;
  inversedBy?: string;
  mappedBy?: string;
}

export interface DraftTwinModel {
  options?: { draftAndPublish?: unknown };
  pluginOptions?: { i18n?: { localized?: unknown } };
  attributes?: Record<string, DraftTwinAttribute | undefined>;
}

/** Strapi's test for a localized type (i18n isLocalizedContentType). */
export function isLocalizedModel(model: DraftTwinModel | undefined): boolean {
  return model?.pluginOptions?.i18n?.localized === true;
}

export interface DraftTwinPlan {
  /** Types to repair, every unidirectional relation target before its source. */
  order: string[];
  /** Types caught in a cycle of unidirectional relations (appended, A→Z). */
  cyclic: string[];
}

function isRepairable(uid: string, model: DraftTwinModel | undefined, skipped: readonly string[]) {
  return (
    uid.startsWith("api::") && model?.options?.draftAndPublish === true && !skipped.includes(uid)
  );
}

/**
 * Which draft & publish types to repair, and in which order. Only the app's
 * own `api::` types: plugin types manage their own rows.
 */
export function planDraftTwinTypes(
  contentTypes: Record<string, DraftTwinModel | undefined>,
  skipped: readonly string[] = DRAFT_TWINS_SKIPPED_UIDS,
): DraftTwinPlan {
  const uids = Object.keys(contentTypes)
    .filter((uid) => isRepairable(uid, contentTypes[uid], skipped))
    .sort();
  const candidates = new Set(uids);

  // uid → the types that must be repaired before it.
  const before = new Map<string, Set<string>>(uids.map((uid) => [uid, new Set<string>()]));
  for (const uid of uids) {
    for (const attribute of Object.values(contentTypes[uid]?.attributes ?? {})) {
      if (attribute?.type !== "relation") continue;
      if (attribute.inversedBy || attribute.mappedBy) continue;
      const target = attribute.target;
      if (!target || target === uid || !candidates.has(target)) continue;
      before.get(uid)?.add(target);
    }
  }

  const order: string[] = [];
  const done = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const uid of uids) {
      if (done.has(uid)) continue;
      if ([...(before.get(uid) ?? [])].every((dependency) => done.has(dependency))) {
        order.push(uid);
        done.add(uid);
        progress = true;
        // Restart from A so the order stays alphabetical among ready types.
        break;
      }
    }
  }
  const cyclic = uids.filter((uid) => !done.has(uid));
  return { order: [...order, ...cyclic], cyclic };
}

export interface DraftTwinRow {
  id: number;
  documentId: string;
  locale?: string | null;
}

/** A row as `db.query` returns it, with any populated relations. */
export type DraftTwinRecord = DraftTwinRow & Record<string, unknown>;

interface DraftTwinQuery {
  findOne(params: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  findMany(params: Record<string, unknown>): Promise<DraftTwinRecord[]>;
  count(params: Record<string, unknown>): Promise<number>;
}

/** The slice of the Strapi instance the repair uses. */
export interface DraftTwinsHost {
  contentTypes: Record<string, DraftTwinModel | undefined>;
  db: {
    query(uid: string): DraftTwinQuery;
    transaction<T>(callback: () => Promise<T>): Promise<T>;
  };
  documents(uid: string): {
    discardDraft?: (params: { documentId: string; locale?: string }) => Promise<unknown>;
  };
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

export interface DraftTwinsOptions {
  batchSize?: number;
  maxPerType?: number;
}

export interface DraftTwinsTypeReport {
  uid: string;
  created: number;
  failed: number;
  /** True when the per-boot cap stopped this type early. */
  capped: boolean;
}

function localeWhere(locale: string | null | undefined) {
  return locale == null ? { $null: true } : locale;
}

/** What a draft must share with a published row to be its twin. */
function rowKey(row: Pick<DraftTwinRow, "documentId" | "locale">, localized: boolean): string {
  return localized ? `${row.documentId}\u0000${row.locale ?? ""}` : row.documentId;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The next page of published rows after `afterId` (id order), and those of
 * them without a draft row of the same documentId (and locale, for a
 * localized type). A document with two published rows (never produced by
 * Strapi) is listed once.
 */
export async function findPublishedOnlyRows(
  strapi: Pick<DraftTwinsHost, "contentTypes" | "db">,
  uid: string,
  afterId: number,
  batchSize: number,
): Promise<{ page: DraftTwinRow[]; missing: DraftTwinRow[] }> {
  const query = strapi.db.query(uid);
  const page = await query.findMany({
    select: ["id", "documentId", "locale"],
    where: { publishedAt: { $notNull: true }, id: { $gt: afterId } },
    orderBy: { id: "asc" },
    limit: batchSize,
  });
  if (page.length === 0) return { page, missing: [] };

  const documentIds = [...new Set(page.map((row) => row.documentId))];
  const drafts = await query.findMany({
    select: ["id", "documentId", "locale"],
    where: { publishedAt: { $null: true }, documentId: { $in: documentIds } },
  });
  const localized = isLocalizedModel(strapi.contentTypes[uid]);
  const covered = new Set(drafts.map((draft) => rowKey(draft, localized)));
  const missing: DraftTwinRow[] = [];
  for (const row of page) {
    const key = rowKey(row, localized);
    if (covered.has(key)) continue;
    covered.add(key);
    missing.push(row);
  }
  return { page, missing };
}

/** A bidirectional one-to-many/-one relation to a draft & publish type. */
interface OneToAnyDraftRelation {
  name: string;
  target: string;
  /** The attribute on the target that links back (its mappedBy/inversedBy). */
  backLink: string;
}

/**
 * The relations of `uid` whose clone re-points the targets' drafts (header,
 * PENDING MOVES): bidirectional one-to-many and one-to-one relations to a
 * draft & publish type, the kind Strapi unlinks from other documents when it
 * attaches them (regular-relations.js:34-43; relations.js isOneToAny).
 */
function oneToAnyDraftRelations(
  contentTypes: DraftTwinsHost["contentTypes"],
  uid: string,
): OneToAnyDraftRelation[] {
  const relations: OneToAnyDraftRelation[] = [];
  for (const [name, attribute] of Object.entries(contentTypes[uid]?.attributes ?? {})) {
    if (attribute?.type !== "relation") continue;
    if (attribute.relation !== "oneToMany" && attribute.relation !== "oneToOne") continue;
    const target = attribute.target;
    const backLink = attribute.mappedBy ?? attribute.inversedBy;
    if (!target || !backLink) continue;
    if (contentTypes[target]?.options?.draftAndPublish !== true) continue;
    relations.push({ name, target, backLink });
  }
  return relations;
}

/** documentIds of a populated relation value (one row, a list, or none). */
function linkedDocumentIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  const ids: string[] = [];
  for (const item of list) {
    const documentId = (item as { documentId?: unknown } | null)?.documentId;
    if (typeof documentId === "string") ids.push(documentId);
  }
  return ids;
}

/**
 * Throws when a target the published row links through such a relation has
 * a draft that links ANOTHER document back (a pending move the clone would
 * revert, header PENDING MOVES). Runs inside the document's transaction.
 */
async function assertNoPendingMoves(
  strapi: Pick<DraftTwinsHost, "contentTypes" | "db">,
  uid: string,
  row: DraftTwinRow,
): Promise<void> {
  const relations = oneToAnyDraftRelations(strapi.contentTypes, uid);
  if (relations.length === 0) return;
  const published = await strapi.db.query(uid).findOne({
    where: { id: row.id },
    populate: Object.fromEntries(relations.map(({ name }) => [name, { select: ["documentId"] }])),
  });
  for (const { name, target, backLink } of relations) {
    const documentIds = [...new Set(linkedDocumentIds(published?.[name]))];
    if (documentIds.length === 0) continue;
    const drafts = await strapi.db.query(target).findMany({
      select: ["id", "documentId"],
      where: { documentId: { $in: documentIds }, publishedAt: { $null: true } },
      populate: { [backLink]: { select: ["documentId"] } },
    });
    for (const draft of drafts) {
      const other = linkedDocumentIds(draft[backLink]).find((id) => id !== row.documentId);
      if (other !== undefined) {
        throw new Error(
          `the pending draft of ${target} ${draft.documentId} links another ${backLink} (${other}); ` +
            "publish or discard that draft",
        );
      }
    }
  }
}

/**
 * Clones one published row into its draft twin, in its own transaction. The
 * draft count is re-checked in that transaction first: discardDraft REPLACES
 * an existing draft, and it must never touch one. Nor may the clone move
 * another document's pending draft (assertNoPendingMoves).
 */
export async function createDraftTwin(
  strapi: Pick<DraftTwinsHost, "contentTypes" | "db" | "documents">,
  uid: string,
  row: DraftTwinRow,
): Promise<boolean> {
  const discardDraft = strapi.documents(uid).discardDraft;
  if (typeof discardDraft !== "function") {
    throw new Error(`${uid} has no discardDraft (draft & publish off?)`);
  }
  const localized = isLocalizedModel(strapi.contentTypes[uid]);
  return strapi.db.transaction(async () => {
    const drafts = await strapi.db.query(uid).count({
      where: {
        documentId: row.documentId,
        ...(localized ? { locale: localeWhere(row.locale) } : {}),
        publishedAt: { $null: true },
      },
    });
    if (drafts > 0) return false;
    await assertNoPendingMoves(strapi, uid, row);
    // A non-localized type has one draft per document, whatever its locale.
    await discardDraft({
      documentId: row.documentId,
      ...(localized && row.locale ? { locale: row.locale } : {}),
    });
    return true;
  });
}

async function repairType(
  strapi: DraftTwinsHost,
  uid: string,
  batchSize: number,
  maxPerType: number,
): Promise<DraftTwinsTypeReport> {
  const report: DraftTwinsTypeReport = { uid, created: 0, failed: 0, capped: false };
  let afterId = 0;
  for (;;) {
    const { page, missing } = await findPublishedOnlyRows(strapi, uid, afterId, batchSize);
    for (const row of missing) {
      if (report.created + report.failed >= maxPerType) {
        report.capped = true;
        return report;
      }
      try {
        if (await createDraftTwin(strapi, uid, row)) report.created++;
      } catch (err) {
        report.failed++;
        strapi.log.error(
          `${DRAFT_TWINS_LOG} ${uid} ${row.documentId}: could not create the draft (${errorMessage(err)}); ` +
            "the next boot retries, and until it has a draft, publishing an entry linked to it drops that link",
        );
      }
    }
    if (page.length < batchSize) return report;
    afterId = page[page.length - 1].id;
  }
}

/**
 * Runs the repair over every repairable type. Never throws; logs one info
 * line per type that got drafts (or failed), and an error per failure.
 */
export async function ensureDraftTwins(
  strapi: DraftTwinsHost,
  options: DraftTwinsOptions = {},
): Promise<DraftTwinsTypeReport[]> {
  const batchSize = options.batchSize ?? DRAFT_TWINS_BATCH_SIZE;
  const maxPerType = options.maxPerType ?? DRAFT_TWINS_MAX_PER_TYPE;
  const reports: DraftTwinsTypeReport[] = [];
  let plan: DraftTwinPlan;
  try {
    plan = planDraftTwinTypes(strapi.contentTypes);
  } catch (err) {
    strapi.log.error(`${DRAFT_TWINS_LOG} could not plan the repair: ${errorMessage(err)}`);
    return reports;
  }
  if (plan.cyclic.length > 0) {
    strapi.log.warn(
      `${DRAFT_TWINS_LOG} unidirectional relations form a cycle between ${plan.cyclic.join(", ")}; ` +
        "a draft may miss a link to a document of that cycle that had no draft yet",
    );
  }
  for (const uid of plan.order) {
    let report: DraftTwinsTypeReport = { uid, created: 0, failed: 0, capped: false };
    try {
      report = await repairType(strapi, uid, batchSize, maxPerType);
    } catch (err) {
      strapi.log.error(
        `${DRAFT_TWINS_LOG} ${uid}: repair stopped (${errorMessage(err)}); the next boot retries`,
      );
    }
    reports.push(report);
    if (report.created > 0 || report.failed > 0) {
      strapi.log.info(
        `${DRAFT_TWINS_LOG} created ${report.created} draft(s) for ${uid}` +
          (report.failed > 0 ? `, ${report.failed} failed` : ""),
      );
    }
    if (report.capped) {
      strapi.log.warn(
        `${DRAFT_TWINS_LOG} ${uid}: stopped after ${maxPerType} document(s) on this boot; the next boot continues`,
      );
    }
  }
  return reports;
}
