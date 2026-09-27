import { POLL_AUDIENCE_ALL, POLL_AUDIENCE_DEPARTMENTS } from "./poll-audience";

/**
 * One-time backfill of the poll `audience` flag (decision 02), run at every
 * boot and a no-op once no poll row has a NULL flag.
 *
 * The flag is a new, nullable column: Strapi adds it on the first boot of
 * this release and leaves existing rows NULL (the enum's `default` only
 * applies to rows written through Strapi, and the column gets no DB
 * default). NULL already reads as "all" (utils/poll-audience.ts), and a
 * poll that links a department is targeted by its links anyway. What the
 * backfill adds is the fail-closed memory: a poll that links a department
 * gets `audience = 'departments'`, so it stays restricted should its
 * departments be deleted later.
 *
 * Why here and not as a database migration: Strapi runs user migrations
 * before the schema sync, so on the first boot the column does not exist
 * yet when they run. bootstrap() runs after the sync.
 *
 * Per ROW, both rows of a document: the draft row (what the admin panel
 * edits and the next publish copies) and the published row (what the read
 * rules evaluate) each get the flag their own links call for. Usually both
 * link the same departments, so both get the same flag; a draft with a
 * saved, unpublished change of departments gets the flag of its own
 * content, exactly what the web form would have set for it.
 *
 * One exception keeps a restricted poll restricted: a NULL row without
 * links whose OTHER row of the same document (same documentId) already
 * says 'departments' gets 'departments' as well. That only happens after a
 * rollback to a cms that does not know the flag: publishing there clones a
 * new published row without the flag, and "Discard changes" a new draft;
 * for a poll restricted only by its flag (all its departments deleted),
 * the per-row rule would turn that row company-wide on rolling forward.
 * On the first boot of this release every row is NULL, so the exception
 * cannot apply there. When BOTH rows lost the flag on the previous cms
 * (published there and then discarded, or created there) nothing is left
 * to tell: that is the accepted residual of a rollback (§7b, DEPLOYMENT.md
 * roll-forward check).
 *
 * ATOMIC AND FAIL CLOSED (Codex review, findings 3 and 4). Classification
 * and every update run in ONE transaction (`strapi.db.transaction`). Any
 * error rolls all of it back and is rethrown as a `[poll-audience]` error,
 * which stops the boot (@strapi/core 5.55.1 Strapi.js start → catch →
 * stopWithError → process.exit(1), before the server listens). Before,
 * a failed sibling lookup or update was logged and the cms served requests
 * with a restricted poll open (a NULL published row without links reads
 * as company-wide), and a run that failed halfway left some rows flagged,
 * which changed the classification of the rest on the next boot (a
 * published row then took its already-flagged draft as a restricted
 * sibling). Now nothing is written unless everything is, so a retry
 * classifies exactly like a clean first run. The operator consequence
 * (deploy.sh stops at `up -d`, restart retries, rollback) is in
 * docs/DEPLOYMENT.md.
 *
 * Runs before the draft-twin repair (utils/draft-twins.ts), so a draft
 * cloned from a published row copies the backfilled flag. `updateMany`
 * leaves `updatedAt` alone (the timestamps subscriber only stamps array
 * payloads), so the admin panel keeps showing Published, not Modified.
 * Each update also requires the flag to still be NULL, so a second process
 * in between is never overwritten.
 */

export const POLL_AUDIENCE_BACKFILL_LOG = "[poll-audience]";

const POLL_UID = "api::poll.poll";

/** Ids per UPDATE statement (keeps well below every driver's bind limit). */
export const POLL_AUDIENCE_BACKFILL_CHUNK = 200;

interface BackfillQuery {
  findMany(params: Record<string, unknown>): Promise<unknown[]>;
  updateMany(params: Record<string, unknown>): Promise<{ count?: number } | undefined>;
}

/** The slice of the Strapi instance the backfill uses. */
export interface PollAudienceBackfillHost {
  db: {
    query(uid: string): BackfillQuery;
    transaction<T>(callback: () => Promise<T>): Promise<T>;
  };
  log: { info(message: string): void };
}

interface NullFlagRow {
  id: number;
  documentId?: unknown;
  departments?: unknown[] | null;
}

/** Rows set per class in one run. */
interface BackfillCounts {
  departments: number;
  siblings: number;
  all: number;
}

const isNullFlagRow = (row: unknown): row is NullFlagRow =>
  typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "number";

async function setAudience(
  query: BackfillQuery,
  ids: number[],
  audience: string,
): Promise<number> {
  let updated = 0;
  for (let start = 0; start < ids.length; start += POLL_AUDIENCE_BACKFILL_CHUNK) {
    const chunk = ids.slice(start, start + POLL_AUDIENCE_BACKFILL_CHUNK);
    const result = await query.updateMany({
      where: { id: { $in: chunk }, audience: { $null: true } },
      data: { audience },
    });
    updated += result?.count ?? 0;
  }
  return updated;
}

const isDocumentId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * The documentIds among `documentIds` that have a row flagged
 * 'departments'. Read before any update of this run, so a row flagged by
 * its links in the same run never counts (first-boot semantics stay per
 * row).
 */
async function restrictedDocuments(query: BackfillQuery, documentIds: string[]): Promise<Set<string>> {
  const restricted = new Set<string>();
  for (let start = 0; start < documentIds.length; start += POLL_AUDIENCE_BACKFILL_CHUNK) {
    const chunk = documentIds.slice(start, start + POLL_AUDIENCE_BACKFILL_CHUNK);
    const siblings = await query.findMany({
      where: { documentId: { $in: chunk }, audience: POLL_AUDIENCE_DEPARTMENTS },
      select: ["documentId"],
    });
    for (const sibling of siblings) {
      const documentId =
        typeof sibling === "object" && sibling !== null
          ? (sibling as { documentId?: unknown }).documentId
          : undefined;
      if (isDocumentId(documentId)) restricted.add(documentId);
    }
  }
  return restricted;
}

/** Classifies every NULL row and writes the flags (inside the transaction). */
async function classifyAndUpdate(query: BackfillQuery): Promise<BackfillCounts | null> {
  const rows = (
    await query.findMany({
      where: { audience: { $null: true } },
      select: ["id", "documentId"],
      populate: { departments: { select: ["id"] } },
    })
  ).filter(isNullFlagRow);
  if (rows.length === 0) return null;

  const hasLinks = (row: NullFlagRow) => (row.departments ?? []).length > 0;
  const unlinkedDocumentIds = [
    ...new Set(rows.filter((row) => !hasLinks(row)).map((row) => row.documentId).filter(isDocumentId)),
  ];
  const restricted = await restrictedDocuments(query, unlinkedDocumentIds);
  const bySibling = (row: NullFlagRow) =>
    !hasLinks(row) && isDocumentId(row.documentId) && restricted.has(row.documentId);

  const linked = rows.filter(hasLinks).map((row) => row.id);
  const siblingRestricted = rows.filter(bySibling).map((row) => row.id);
  const companyWide = rows.filter((row) => !hasLinks(row) && !bySibling(row)).map((row) => row.id);

  return {
    departments: await setAudience(query, linked, POLL_AUDIENCE_DEPARTMENTS),
    siblings: await setAudience(query, siblingRestricted, POLL_AUDIENCE_DEPARTMENTS),
    all: await setAudience(query, companyWide, POLL_AUDIENCE_ALL),
  };
}

/**
 * Runs the backfill. Resolves once every NULL row has its flag (logging
 * one line when it set any); rejects with a `[poll-audience]` error, after
 * the transaction rolled back, when anything failed.
 */
export async function backfillPollAudience(strapi: PollAudienceBackfillHost): Promise<void> {
  let counts: BackfillCounts | null;
  try {
    counts = await strapi.db.transaction(() => classifyAndUpdate(strapi.db.query(POLL_UID)));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${POLL_AUDIENCE_BACKFILL_LOG} could not backfill the audience of existing polls (${reason}); ` +
        "nothing was changed (the transaction rolled back), and the cms does not start, because a poll row " +
        "without the flag can leave a restricted poll open. Fix the cause and start the cms again " +
        "(every start retries), or roll back (docs/DEPLOYMENT.md)",
    );
  }
  if (counts === null) return;
  const { departments, siblings, all } = counts;
  const siblingNote =
    siblings > 0 ? `${siblings} to 'departments' (the other row of their poll is restricted), ` : "";
  strapi.log.info(
    `${POLL_AUDIENCE_BACKFILL_LOG} set the audience of ${departments + siblings + all} existing poll row(s): ` +
      `${departments} to 'departments' (they link a department), ${siblingNote}${all} to 'all'`,
  );
}
