import { ANNOUNCEMENT_UID, EVENT_UID } from "./authoring-uids";

/**
 * Boot backfill of the announcement and event targeting flags (decision 06
 * §N9, amendment row A5; batch 15 plan item 6), run at every boot right
 * after the document/quick-link backfill and before the demo seed and the
 * draft-twin repair (src/index.ts), so a draft the twin repair clones
 * copies the repaired value.
 *
 * WHY. The targeting guard (15D) judges rows after a write, so a legacy
 * item whose first post-upgrade edit removes its targets would find no
 * link left to flag. And `notify_audience` / `retarget_required` come up
 * NULL on every existing row: a schema default applies only to Strapi
 * writes (poll-audience-backfill.ts header). NULL reads as `all` and as
 * false, so nothing changes for readers; what the backfill adds is the
 * fail-closed memory.
 *
 * PER ROW, BOTH TWINS, RAISE-ONLY:
 *   - announcement `audience = 'departments'` on every row that links a
 *     department or a team;
 *   - event `notify_audience = 'departments'` on every row that links a
 *     department; a NULL row without one gets `all`, except under the twin
 *     rule.
 * It never lowers a flag, never touches the marker except by the twin rule.
 *
 * THE TWIN RULE (the pattern of poll-audience-backfill.ts; plan review
 * finding 1). On the batch-14 image a "Discard changes" rebuilds the draft
 * from the published row through the old model, which does not know these
 * columns, and a publish rebuilds the published row from the draft: the
 * rebuilt row comes back NULL. A per-row rule alone would turn an event
 * restricted only by its flag (its departments deleted) into `all`, and its
 * next publish would notify the whole company. So:
 *   - an event row whose `notify_audience` is NULL and that links no
 *     department takes `departments` when the OTHER row of the same
 *     documentId says `departments`; only without a restricting twin does
 *     it get `all`;
 *   - an announcement row whose `retarget_required` is NULL takes `true`
 *     when its twin says `true`. Otherwise the marker is left alone.
 * Residual: when BOTH rows lost the value on batch 14 (published there,
 * then discarded), nothing is left to tell; the saved lists of the
 * rollback runbook cover it (docs/DEPLOYMENT.md, the same accepted residual
 * as the poll backfill).
 *
 * ATOMIC AND FAIL CLOSED, like its siblings: classification and every
 * update in ONE transaction; every read (the link tables in id pages, the
 * NULL rows, the twins) happens before the first update, so a row flagged
 * in this run never counts as a restricting twin; each update also
 * requires the column to be in the state it was classified in (NULL, or
 * not yet raised), so a second process in between is never overwritten.
 * Idempotent: a later boot finds nothing to change. Any error rolls all of
 * it back and is rethrown as a `[targeting-flags]` error, which stops the
 * boot (the cms does not serve while a flag may be missing). `updateMany`
 * with an object payload leaves `updatedAt` alone (the panel keeps
 * "Published").
 *
 * A raw writer of guarded types under §G "Rule": it only raises flags and
 * the marker (raw-writers.test.ts).
 */

export const TARGETING_FLAGS_LOG = "[targeting-flags]";

/** Rows per read page and ids or documentIds per lookup and UPDATE. */
export const TARGETING_FLAGS_CHUNK = 200;

const DEPARTMENTS = "departments";
const ALL = "all";

interface BackfillQuery {
  findMany(params: Record<string, unknown>): Promise<unknown[]>;
  updateMany(params: Record<string, unknown>): Promise<{ count?: number } | undefined>;
}

/** The slice of the Strapi instance the backfill uses. */
export interface TargetingFlagsBackfillHost {
  db: {
    query(uid: string): BackfillQuery;
    transaction<T>(callback: () => Promise<T>): Promise<T>;
    metadata: { get(uid: string): unknown };
  };
  log: { info(message: string): void };
}

/** What one run changed. */
export interface TargetingFlagsCounts {
  announcementAudience: number;
  announcementRetargetTwins: number;
  eventLinked: number;
  eventTwins: number;
  eventAll: number;
}

interface LinkTable {
  table: string;
  rowColumn: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The link table of `<uid>.<attribute>` from Strapi's metadata (fail closed). */
export function linkTableOf(
  strapi: Pick<TargetingFlagsBackfillHost, "db">,
  uid: string,
  attribute: string,
): LinkTable {
  const joinTable = field(
    field(field(strapi.db.metadata.get(uid), "attributes"), attribute),
    "joinTable",
  );
  const table = field(joinTable, "name");
  const rowColumn = field(field(joinTable, "joinColumn"), "name");
  if (!isName(table) || !isName(rowColumn)) {
    throw new Error(`the link table of ${uid}.${attribute} is unknown`);
  }
  return { table, rowColumn };
}

/**
 * A row id as a number: drivers hand back an integer column as a number,
 * a bigint one as a numeric string; anything else is no id (null).
 */
export function idOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === "string" && /^[1-9]\d{0,15}$/.test(value)) {
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : null;
  }
  return null;
}

/**
 * The ids under `key` of `rows`. A row without a usable id fails the
 * backfill (fail closed): skipping it would leave its flag unraised in
 * silence.
 */
function numbersOf(rows: unknown[], key: string, source: string): number[] {
  return rows.map((row) => {
    const id = idOf(field(row, key));
    if (id === null) {
      throw new Error(`${source} returned a row without a numeric ${key}`);
    }
    return id;
  });
}

/** Every row id that has a link in `link`, read in id pages of the link table. */
async function linkedRowIds(
  strapi: Pick<TargetingFlagsBackfillHost, "db">,
  link: LinkTable,
): Promise<Set<number>> {
  const ids = new Set<number>();
  const links = strapi.db.query(link.table);
  let afterId = 0;
  for (;;) {
    const page = await links.findMany({
      where: { id: { $gt: afterId } },
      select: ["id", link.rowColumn],
      orderBy: { id: "asc" },
      limit: TARGETING_FLAGS_CHUNK,
    });
    for (const id of numbersOf(page, link.rowColumn, link.table)) ids.add(id);
    const linkIds = numbersOf(page, "id", link.table);
    if (linkIds.length < TARGETING_FLAGS_CHUNK) return ids;
    const last = linkIds[linkIds.length - 1];
    if (last <= afterId)
      throw new Error(`the read of ${link.table} did not advance past id ${afterId}`);
    afterId = last;
  }
}

interface RowRef {
  id: number;
  documentId: string | null;
}

/** Every row of `uid` matching `where`, as {id, documentId}, in id pages. */
async function rowsWhere(
  strapi: Pick<TargetingFlagsBackfillHost, "db">,
  uid: string,
  where: Record<string, unknown>,
): Promise<RowRef[]> {
  const query = strapi.db.query(uid);
  const rows: RowRef[] = [];
  let afterId = 0;
  for (;;) {
    const page = await query.findMany({
      where: { $and: [where, { id: { $gt: afterId } }] },
      select: ["id", "documentId"],
      orderBy: { id: "asc" },
      limit: TARGETING_FLAGS_CHUNK,
    });
    const ids = numbersOf(page, "id", uid);
    const refs = page.map((row, index) => {
      const documentId = field(row, "documentId");
      return { id: ids[index], documentId: isName(documentId) ? documentId : null };
    });
    rows.push(...refs);
    if (page.length < TARGETING_FLAGS_CHUNK) return rows;
    const last = refs.length > 0 ? refs[refs.length - 1].id : afterId;
    if (last <= afterId)
      throw new Error(`the read of ${uid} rows did not advance past id ${afterId}`);
    afterId = last;
  }
}

/** The distinct documentIds of `rows`. */
const documentIdsOf = (rows: readonly RowRef[]): string[] => [
  ...new Set(rows.map((row) => row.documentId).filter(isName)),
];

/** The documentIds among `documentIds` with a row matching `where` (read in chunks). */
async function documentsWhere(
  strapi: Pick<TargetingFlagsBackfillHost, "db">,
  uid: string,
  documentIds: readonly string[],
  where: Record<string, unknown>,
): Promise<Set<string>> {
  const found = new Set<string>();
  const query = strapi.db.query(uid);
  for (let start = 0; start < documentIds.length; start += TARGETING_FLAGS_CHUNK) {
    const chunk = documentIds.slice(start, start + TARGETING_FLAGS_CHUNK);
    const rows = await query.findMany({
      where: { documentId: { $in: chunk }, ...where },
      select: ["documentId"],
    });
    for (const row of rows) {
      const documentId = field(row, "documentId");
      if (isName(documentId)) found.add(documentId);
    }
  }
  return found;
}

/** `data` on `ids` (chunked), each update also matching `guard`; returns the rows changed. */
async function setWhere(
  query: BackfillQuery,
  ids: readonly number[],
  guard: Record<string, unknown>,
  data: Record<string, unknown>,
): Promise<number> {
  let changed = 0;
  for (let start = 0; start < ids.length; start += TARGETING_FLAGS_CHUNK) {
    const chunk = ids.slice(start, start + TARGETING_FLAGS_CHUNK);
    const result = await query.updateMany({ where: { id: { $in: chunk }, ...guard }, data });
    changed += result?.count ?? 0;
  }
  return changed;
}

const notRaised = (column: string, value: unknown) => ({
  $or: [{ [column]: { $null: true } }, { [column]: { $ne: value } }],
});

/** Reads everything, then writes (inside the caller's transaction). */
async function classifyAndUpdate(
  strapi: Pick<TargetingFlagsBackfillHost, "db">,
): Promise<TargetingFlagsCounts> {
  // --- Reads: nothing below them writes before the last one.
  const announcementDepartment = linkTableOf(strapi, ANNOUNCEMENT_UID, "department");
  const announcementTeam = linkTableOf(strapi, ANNOUNCEMENT_UID, "team");
  const eventDepartments = linkTableOf(strapi, EVENT_UID, "departments");

  const announcementLinked = new Set([
    ...(await linkedRowIds(strapi, announcementDepartment)),
    ...(await linkedRowIds(strapi, announcementTeam)),
  ]);
  const eventLinked = await linkedRowIds(strapi, eventDepartments);

  const nullEvents = await rowsWhere(strapi, EVENT_UID, { notifyAudience: { $null: true } });
  const unlinkedNullEvents = nullEvents.filter((row) => !eventLinked.has(row.id));
  const restrictedEventDocuments = await documentsWhere(
    strapi,
    EVENT_UID,
    documentIdsOf(unlinkedNullEvents),
    { notifyAudience: DEPARTMENTS },
  );

  const markedAnnouncements = await rowsWhere(strapi, ANNOUNCEMENT_UID, { retargetRequired: true });
  const markedDocuments = documentIdsOf(markedAnnouncements);
  const unmarkedTwins: number[] = [];
  for (let start = 0; start < markedDocuments.length; start += TARGETING_FLAGS_CHUNK) {
    const chunk = markedDocuments.slice(start, start + TARGETING_FLAGS_CHUNK);
    const twins = await rowsWhere(strapi, ANNOUNCEMENT_UID, {
      documentId: { $in: chunk },
      retargetRequired: { $null: true },
    });
    unmarkedTwins.push(...twins.map((row) => row.id));
  }

  const byTwin = (row: RowRef) =>
    row.documentId !== null && restrictedEventDocuments.has(row.documentId);
  const eventTwinIds = unlinkedNullEvents.filter(byTwin).map((row) => row.id);
  const eventAllIds = unlinkedNullEvents.filter((row) => !byTwin(row)).map((row) => row.id);

  // --- Writes, each guarded by the state it was classified in.
  const announcements = strapi.db.query(ANNOUNCEMENT_UID);
  const events = strapi.db.query(EVENT_UID);
  return {
    announcementAudience: await setWhere(
      announcements,
      [...announcementLinked].sort((a, b) => a - b),
      notRaised("audience", DEPARTMENTS),
      { audience: DEPARTMENTS },
    ),
    announcementRetargetTwins: await setWhere(
      announcements,
      unmarkedTwins,
      { retargetRequired: { $null: true } },
      { retargetRequired: true },
    ),
    eventLinked: await setWhere(
      events,
      [...eventLinked].sort((a, b) => a - b),
      notRaised("notifyAudience", DEPARTMENTS),
      { notifyAudience: DEPARTMENTS },
    ),
    eventTwins: await setWhere(
      events,
      eventTwinIds,
      { notifyAudience: { $null: true } },
      { notifyAudience: DEPARTMENTS },
    ),
    eventAll: await setWhere(
      events,
      eventAllIds,
      { notifyAudience: { $null: true } },
      { notifyAudience: ALL },
    ),
  };
}

/**
 * Runs the backfill. Resolves once every flag is in place (logging one line
 * with the counts when it changed anything); rejects with a
 * `[targeting-flags]` error, after the transaction rolled back, when
 * anything failed.
 */
export async function backfillTargetingFlags(
  strapi: TargetingFlagsBackfillHost,
): Promise<TargetingFlagsCounts> {
  let counts: TargetingFlagsCounts;
  try {
    counts = await strapi.db.transaction(() => classifyAndUpdate(strapi));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${TARGETING_FLAGS_LOG} could not backfill the announcement and event targeting flags (${reason}); ` +
        "nothing was changed (the transaction rolled back), and the cms does not start, because a row " +
        "without its flag can turn company-wide when its targets are deleted. Fix the cause and start " +
        "the cms again (every start retries), or roll back (docs/DEPLOYMENT.md)",
    );
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total > 0) {
    strapi.log.info(
      `${TARGETING_FLAGS_LOG} announcements: audience 'departments' on ${counts.announcementAudience} ` +
        `row(s) that link a department or team, retargetRequired from the twin on ` +
        `${counts.announcementRetargetTwins}; events: notifyAudience 'departments' on ` +
        `${counts.eventLinked} row(s) that link a department and on ${counts.eventTwins} from the twin, ` +
        `'all' on ${counts.eventAll}`,
    );
  }
  return counts;
}
