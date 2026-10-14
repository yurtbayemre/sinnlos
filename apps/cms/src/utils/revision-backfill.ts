/**
 * Boot backfill of the wiki page history (decision 06 §J4; batch 16 lane
 * 16D item 3; S26), run at every boot after the targeting-flag backfill and
 * before the demo seed and the draft-twin repair (src/index.ts).
 *
 * WHY. The columns of batch 16 (`page_document_id`, `kind`, ...) come up
 * NULL on every existing revision: Strapi's schema sync adds them, and a
 * schema default applies only to Strapi writes. And a page's CURRENT content
 * is in no revision at all: the lifecycle of batches up to 15.1 recorded the
 * body BEFORE an edit, never the state after it, so the first save of batch
 * 16 would make the content at the upgrade unrestorable. The same holds
 * after every rollback window: batch 15.1 changes pages without recording
 * the new state.
 *
 * WHAT, in ONE transaction:
 *   1. the anchor: `page_document_id` where it is NULL and the revision's
 *      `page` link rows resolve to EXACTLY ONE page document (every revision
 *      has one link row per page row it reached, spike 5 S5.7). None (the
 *      page was deleted) or several (a damaged link table) leave it NULL:
 *      no history action reaches such a row, and the count is logged;
 *   2. the kind: `before` where it is NULL. Rows of batches up to 15.1 and
 *      rows a batch-15.1 image wrote during a rollback window are both
 *      before-images; every row of batch 16 carries its kind;
 *   3. the CUTOVER BASELINE: for every wiki page, its draft row and its
 *      published row (where one exists) are checked EACH ON ITS OWN: a state
 *      that no `after` or `baseline` revision of the page holds (equal
 *      title, body and summary; empty and missing compare equal) gets a
 *      `baseline` revision, the published one first, so the newest
 *      snapshot is the draft. Editor and admin unset, `publishedAt` set
 *      (S4), the `page` link to the draft row (the published row for a page
 *      without one). On the first boot of batch 16 that records every
 *      page's content; after a rollback window, the content batch 15.1
 *      wrote; later boots find nothing to do. The check is one read
 *      (NOT EXISTS against the page_document_id index), not one per page.
 *
 * ATOMIC AND FAIL CLOSED, like its siblings: any error rolls all of it
 * back and is rethrown as a `[revision-backfill]` error, which stops the
 * boot: a cms that saves pages before their baseline exists makes the
 * content at the cutover unrestorable. Idempotent. Logs one line with the
 * counts when it changed anything, nothing otherwise. Every raw statement
 * runs on the transaction (`transacting`); the query-engine writes join it
 * on their own. A raw writer of a non-guarded type (raw-writers.test.ts).
 */

export const REVISION_BACKFILL_LOG = "[revision-backfill]";

const PAGE_UID = "api::wiki-page.wiki-page";
const REVISION_UID = "api::wiki-revision.wiki-revision";

/** Revision ids per UPDATE. */
const CHUNK = 200;

interface RawQuery extends PromiseLike<unknown> {
  transacting(trx: unknown): PromiseLike<unknown>;
}

/** The slice of the Strapi instance the backfill uses. */
export interface RevisionBackfillHost {
  db: {
    connection: { raw(sql: string, bindings?: readonly unknown[]): RawQuery };
    getSchemaName?(): string | null | undefined;
    metadata: { get(uid: string): unknown };
    query(uid: string): {
      updateMany(params: Record<string, unknown>): Promise<{ count?: number } | undefined>;
      create(params: { data: Record<string, unknown> }): Promise<unknown>;
      count(params: Record<string, unknown>): Promise<number>;
    };
    transaction<T>(callback: (scope: { trx: unknown }) => Promise<T>): Promise<T>;
  };
  log: { info(message: string): void };
}

/** What one run changed (`unanchored`: rows left without an anchor afterwards). */
export interface RevisionBackfillCounts {
  anchored: number;
  kinds: number;
  baselines: number;
  unanchored: number;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const rawRows = (result: unknown): Record<string, unknown>[] => {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = field(result, "rows");
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
};

/** A row id from a driver (a number, or a numeric string for a bigint on pg). */
function idOf(value: unknown, source: string): number {
  const id = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${source} returned a row without a numeric id`);
  }
  return id;
}

/** Table and column names from Strapi's metadata (fail closed). */
function namesOf(strapi: RevisionBackfillHost) {
  const schema = strapi.db.getSchemaName?.() || null;
  const qualify = (name: string) => (schema ? `${schema}.${name}` : name);
  const model = (uid: string) => {
    const meta = strapi.db.metadata.get(uid);
    const table = field(meta, "tableName");
    if (!isName(table)) throw new Error(`the model ${uid} is not loaded`);
    const attributes = field(meta, "attributes");
    return {
      attributes,
      table: qualify(table),
      column: (attribute: string, fallback: string) => {
        const name = field(field(attributes, attribute), "columnName");
        return isName(name) ? name : fallback;
      },
    };
  };
  const page = model(PAGE_UID);
  const revision = model(REVISION_UID);
  const joinTable = field(field(revision.attributes, "page"), "joinTable");
  const link = field(joinTable, "name");
  const linkRevision = field(field(joinTable, "joinColumn"), "name");
  const linkPage = field(field(joinTable, "inverseJoinColumn"), "name");
  if (!isName(link) || !isName(linkRevision) || !isName(linkPage)) {
    throw new Error(`the link table of ${REVISION_UID}.page is unknown`);
  }
  return { page, revision, link: { table: qualify(link), revision: linkRevision, page: linkPage } };
}

type Names = ReturnType<typeof namesOf>;

/** Step 1: the revisions without an anchor whose links name exactly one page document. */
async function anchors(
  strapi: RevisionBackfillHost,
  names: Names,
  trx: unknown,
): Promise<Map<string, number[]>> {
  const { page, revision, link } = names;
  const result = await strapi.db.connection
    .raw(
      `SELECT l.?? AS revision_id, p.?? AS page_document_id
         FROM ?? AS l
         JOIN ?? AS r ON r.?? = l.??
         JOIN ?? AS p ON p.?? = l.??
        WHERE r.?? IS NULL`,
      [
        link.revision,
        page.column("documentId", "document_id"),
        link.table,
        revision.table,
        revision.column("id", "id"),
        link.revision,
        page.table,
        page.column("id", "id"),
        link.page,
        revision.column("pageDocumentId", "page_document_id"),
      ],
    )
    .transacting(trx);
  const documentsOf = new Map<number, Set<string>>();
  for (const row of rawRows(result)) {
    const id = idOf(row.revision_id, link.table);
    const documentId = row.page_document_id;
    if (!isName(documentId)) continue;
    const set = documentsOf.get(id) ?? new Set<string>();
    set.add(documentId);
    documentsOf.set(id, set);
  }
  const byDocument = new Map<string, number[]>();
  for (const [id, documents] of documentsOf) {
    if (documents.size !== 1) continue;
    const [documentId] = documents;
    byDocument.set(documentId, [...(byDocument.get(documentId) ?? []), id]);
  }
  return byDocument;
}

interface PageState {
  id: number;
  documentId: string;
  published: boolean;
  title: unknown;
  body: unknown;
  summary: unknown;
}

/** Step 3: the page rows whose state no `after` or `baseline` revision of the page holds. */
async function unrecordedStates(
  strapi: RevisionBackfillHost,
  names: Names,
  trx: unknown,
): Promise<PageState[]> {
  const { page, revision } = names;
  const p = (attribute: string, fallback: string) => page.column(attribute, fallback);
  const r = (attribute: string, fallback: string) => revision.column(attribute, fallback);
  const result = await strapi.db.connection
    .raw(
      `SELECT p.?? AS id, p.?? AS document_id, p.?? AS published_at,
              p.?? AS title, p.?? AS body, p.?? AS summary
         FROM ?? AS p
        WHERE p.?? IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ?? AS r
             WHERE r.?? = p.?? AND r.?? IN (?, ?)
               AND COALESCE(r.??, '') = COALESCE(p.??, '')
               AND COALESCE(r.??, '') = COALESCE(p.??, '')
               AND COALESCE(r.??, '') = COALESCE(p.??, ''))
        ORDER BY p.?? ASC, p.?? ASC`,
      [
        p("id", "id"),
        p("documentId", "document_id"),
        p("publishedAt", "published_at"),
        p("title", "title"),
        p("body", "body"),
        p("summary", "summary"),
        page.table,
        p("documentId", "document_id"),
        revision.table,
        r("pageDocumentId", "page_document_id"),
        p("documentId", "document_id"),
        r("kind", "kind"),
        "after",
        "baseline",
        r("title", "title"),
        p("title", "title"),
        r("body", "body"),
        p("body", "body"),
        r("pageSummary", "page_summary"),
        p("summary", "summary"),
        p("documentId", "document_id"),
        p("id", "id"),
      ],
    )
    .transacting(trx);
  return rawRows(result).map((row) => ({
    id: idOf(row.id, page.table),
    documentId: String(row.document_id),
    published: row.published_at !== null && row.published_at !== undefined,
    title: row.title,
    body: row.body,
    summary: row.summary,
  }));
}

const plain = (value: unknown) => (typeof value === "string" ? value : "");
const text = (value: unknown) => (typeof value === "string" ? value : null);
const sameState = (a: PageState, b: PageState) =>
  plain(a.title) === plain(b.title) &&
  plain(a.body) === plain(b.body) &&
  plain(a.summary) === plain(b.summary);

/** The draft row of `documentId`, else any row of it (the baseline's `page` link). */
async function linkRowOf(
  strapi: RevisionBackfillHost,
  names: Names,
  trx: unknown,
  documentId: string,
): Promise<number> {
  const { page } = names;
  const result = await strapi.db.connection
    .raw(`SELECT p.?? AS id FROM ?? AS p WHERE p.?? = ? ORDER BY p.?? IS NULL DESC, p.?? ASC`, [
      page.column("id", "id"),
      page.table,
      page.column("documentId", "document_id"),
      documentId,
      page.column("publishedAt", "published_at"),
      page.column("id", "id"),
    ])
    .transacting(trx);
  const [row] = rawRows(result);
  return idOf(row?.id, page.table);
}

async function backfill(
  strapi: RevisionBackfillHost,
  trx: unknown,
): Promise<RevisionBackfillCounts> {
  const names = namesOf(strapi);
  const revisions = strapi.db.query(REVISION_UID);

  // 1. Anchors (only where NULL; an anchor is never changed).
  let anchored = 0;
  for (const [pageDocumentId, ids] of await anchors(strapi, names, trx)) {
    for (let start = 0; start < ids.length; start += CHUNK) {
      const result = await revisions.updateMany({
        where: { id: { $in: ids.slice(start, start + CHUNK) }, pageDocumentId: { $null: true } },
        data: { pageDocumentId },
      });
      anchored += result?.count ?? 0;
    }
  }

  // 2. Legacy rows are before-images.
  const kinds =
    (await revisions.updateMany({ where: { kind: { $null: true } }, data: { kind: "before" } }))
      ?.count ?? 0;

  // 3. The cutover baseline, per page: the published state first, then the draft.
  const states = await unrecordedStates(strapi, names, trx);
  const byDocument = new Map<string, PageState[]>();
  for (const state of states) {
    byDocument.set(state.documentId, [...(byDocument.get(state.documentId) ?? []), state]);
  }
  let baselines = 0;
  for (const [documentId, rows] of byDocument) {
    const ordered = [...rows].sort((a, b) => Number(b.published) - Number(a.published));
    const written: PageState[] = [];
    const linkRow = await linkRowOf(strapi, names, trx, documentId);
    for (const state of ordered) {
      if (written.some((done) => sameState(done, state))) continue;
      await revisions.create({
        data: {
          page: linkRow,
          pageDocumentId: documentId,
          title: text(state.title),
          body: text(state.body),
          pageSummary: text(state.summary),
          summary: null,
          kind: "baseline",
          editor: null,
          adminEditorId: null,
          restoredFrom: null,
          publishedAt: new Date(),
        },
      });
      written.push(state);
      baselines += 1;
    }
  }

  const unanchored = await revisions.count({ where: { pageDocumentId: { $null: true } } });
  return { anchored, kinds, baselines, unanchored };
}

/**
 * Runs the backfill (see the module comment). Resolves with the counts,
 * logging one line when anything changed; rejects with a
 * `[revision-backfill]` error, after the transaction rolled back, when
 * anything failed.
 */
export async function backfillRevisions(
  strapi: RevisionBackfillHost,
): Promise<RevisionBackfillCounts> {
  let counts: RevisionBackfillCounts;
  try {
    counts = await strapi.db.transaction(({ trx }) => backfill(strapi, trx));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${REVISION_BACKFILL_LOG} could not backfill the wiki revisions (${reason}); nothing was ` +
        "changed (the transaction rolled back), and the cms does not start, because a page saved " +
        "before its baseline exists loses the content it had at the upgrade. Fix the cause and " +
        "start the cms again (every start retries), or roll back (docs/DEPLOYMENT.md)",
    );
  }
  if (counts.anchored + counts.kinds + counts.baselines > 0) {
    strapi.log.info(
      `${REVISION_BACKFILL_LOG} anchored ${counts.anchored} revision(s) to their page, marked ` +
        `${counts.kinds} legacy revision(s) 'before', wrote ${counts.baselines} baseline(s); ` +
        `${counts.unanchored} revision(s) have no page anchor (page deleted, or linked to several pages)`,
    );
  }
  return counts;
}
