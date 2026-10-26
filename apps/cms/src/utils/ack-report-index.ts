/**
 * POST /api/acknowledgements/report-index (v0.31, #173): who confirmed
 * which of up to REPORT_INDEX_MAX_IDS announcements or documents, for the
 * admin's /manage/acknowledgements report (one page of 20 items per
 * section). It replaces the web's walk of /api/acknowledgements, 100 rows a
 * request, one chunk after the other.
 *
 * The rows are read here in id order, PAGE at a time, with only the target
 * and the user id. The budget keeps the web's former one: 2,000 scanned
 * rows per requested item (one receipt per user and item for up to 2,000
 * users, lib/users.ts's directory cap), counted before duplicates collapse.
 * One row past it is looked ahead for: exactly the budget answers
 * `truncated: false`, a further matching row `true`, and the report then
 * never reads as complete (#14). A receipt whose user is gone is skipped;
 * blocked and other ineligible users stay, the report's audience rules
 * drop them (apps/web/src/lib/ack-report.ts).
 */
export const REPORT_INDEX_MAX_IDS = 20;

/** Scanned receipts allowed per requested item before `truncated`. */
export const REPORT_ACKS_PER_ITEM = 2_000;

const ACK_UID = "api::acknowledgement.acknowledgement";
const PAGE = 1_000;

export interface ReportIndexHost {
  db: { query(uid: string): { findMany(params: Record<string, unknown>): Promise<unknown> } };
}

export interface ReportIndex {
  /** Every requested documentId → the ids of the users who confirmed it, ascending. */
  acks: Record<string, number[]>;
  truncated: boolean;
}

interface ReceiptRow {
  id?: unknown;
  targetDocumentId?: unknown;
  user?: { id?: unknown } | null;
}

export async function reportAckIndex(
  strapi: ReportIndexHost,
  targetType: "announcement" | "document",
  documentIds: readonly string[],
): Promise<ReportIndex> {
  const users = new Map(documentIds.map((id) => [id, new Set<number>()]));
  const budget = REPORT_ACKS_PER_ITEM * documentIds.length;
  let scanned = 0;
  let afterId = 0;
  let truncated = false;
  while (users.size > 0 && !truncated) {
    const limit = Math.min(PAGE, budget + 1 - scanned);
    const rows = (await strapi.db.query(ACK_UID).findMany({
      where: { targetType, targetDocumentId: { $in: [...users.keys()] }, id: { $gt: afterId } },
      select: ["id", "targetDocumentId"],
      populate: { user: { select: ["id"] } },
      orderBy: [{ id: "asc" }],
      limit,
    })) as ReceiptRow[];
    for (const row of rows) {
      scanned += 1;
      if (scanned > budget) {
        truncated = true;
        break;
      }
      const userId = row.user?.id;
      const set = typeof row.targetDocumentId === "string" ? users.get(row.targetDocumentId) : null;
      if (set && typeof userId === "number") set.add(userId);
    }
    if (rows.length < limit) break;
    afterId = Number(rows[rows.length - 1].id);
  }
  return {
    acks: Object.fromEntries([...users].map(([id, set]) => [id, [...set].sort((a, b) => a - b)])),
    truncated,
  };
}
