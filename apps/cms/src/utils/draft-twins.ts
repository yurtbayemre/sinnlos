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
 *     includes the inverse (mappedBy) side (utils/populate.js:15-24), and the
 *     link-table cleanup keeps the rows of the other twin
 *     (@strapi/database entity-manager/regular-relations.js:34-49);
 *   - self relations (wiki-page parent/children): remapped to whichever twin
 *     exists when either end is cloned (utils/self-referential-relations.js);
 *   - relations to types without draft & publish (users, departments, teams,
 *     media) link the same single row (dp.js:12-16);
 *   - relations FROM types without draft & publish (poll-vote.poll) are
 *     copied onto the new draft as well (utils/unidirectional-relations.js:
 *     69-98), the state Strapi keeps for such links anyway (dp.js:43-48).
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
 * SIDE EFFECTS: none of consequence. Only `create` runs for the new draft
 * row, with `publishedAt` null; join-table rows are written raw. So the
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
 * admin-panel defect.
 *
 * IDEMPOTENT and BOUNDED. Selection is "published row without a draft row of
 * the same documentId and locale", re-checked inside each document's
 * transaction right before discardDraft (which would otherwise replace an
 * existing draft). Published rows are read in id-ordered pages, and each boot
 * handles at most `maxPerType` documents per type. A steady-state boot costs
 * two small queries per type and page.
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
  attributes?: Record<string, DraftTwinAttribute | undefined>;
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

interface DraftTwinQuery {
  findMany(params: Record<string, unknown>): Promise<DraftTwinRow[]>;
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

function rowKey(row: Pick<DraftTwinRow, "documentId" | "locale">): string {
  return `${row.documentId}\u0000${row.locale ?? ""}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The next page of published rows after `afterId` (id order), and those of
 * them without a draft row of the same documentId and locale. A document
 * with two published rows (never produced by Strapi) is listed once.
 */
export async function findPublishedOnlyRows(
  strapi: Pick<DraftTwinsHost, "db">,
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
  const covered = new Set(drafts.map(rowKey));
  const missing: DraftTwinRow[] = [];
  for (const row of page) {
    const key = rowKey(row);
    if (covered.has(key)) continue;
    covered.add(key);
    missing.push(row);
  }
  return { page, missing };
}

/**
 * Clones one published row into its draft twin, in its own transaction. The
 * draft count is re-checked in that transaction first: discardDraft REPLACES
 * an existing draft, and it must never touch one.
 */
export async function createDraftTwin(
  strapi: Pick<DraftTwinsHost, "db" | "documents">,
  uid: string,
  row: DraftTwinRow,
): Promise<boolean> {
  const discardDraft = strapi.documents(uid).discardDraft;
  if (typeof discardDraft !== "function") {
    throw new Error(`${uid} has no discardDraft (draft & publish off?)`);
  }
  return strapi.db.transaction(async () => {
    const drafts = await strapi.db.query(uid).count({
      where: {
        documentId: row.documentId,
        locale: localeWhere(row.locale),
        publishedAt: { $null: true },
      },
    });
    if (drafts > 0) return false;
    await discardDraft({
      documentId: row.documentId,
      ...(row.locale ? { locale: row.locale } : {}),
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
          `${DRAFT_TWINS_LOG} ${uid} ${row.documentId}: could not create the draft (${errorMessage(err)}); the next boot retries`,
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
