import { POLL_AUDIENCE_ALL, POLL_AUDIENCE_DEPARTMENTS } from "./poll-audience";

/**
 * One-time backfill of the poll `audience` flag (decision 02), run at every
 * boot and a no-op once no poll row has a NULL flag.
 *
 * The flag is a new, nullable column: Strapi adds it on the first boot of
 * this release and leaves existing rows NULL (the enum's `default` only
 * applies to rows written through Strapi, and the column gets no DB
 * default). NULL already reads as "all" (utils/poll-audience.ts), and a
 * poll that links a department is targeted by its links anyway, so nothing
 * opens up before or without this backfill. What it adds is the fail-closed
 * memory: a poll that links a department gets `audience = 'departments'`,
 * so it stays restricted should its departments be deleted later.
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
 * cannot apply there.
 *
 * Runs before the draft-twin repair (utils/draft-twins.ts), so a draft
 * cloned from a published row copies the backfilled flag. `updateMany` leaves `updatedAt`
 * alone (the timestamps subscriber only stamps array payloads), so the
 * admin panel keeps showing Published, not Modified.
 *
 * Idempotent and concurrency-safe: each update also requires the flag to
 * still be NULL, so a second process or an admin save in between is never
 * overwritten. Never fails the boot: an error is logged, and the next boot
 * retries.
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
  db: { query(uid: string): BackfillQuery };
  log: { info(message: string): void; warn(message: string): void };
}

interface NullFlagRow {
  id: number;
  documentId?: unknown;
  departments?: unknown[] | null;
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

export async function backfillPollAudience(strapi: PollAudienceBackfillHost): Promise<void> {
  try {
    const query = strapi.db.query(POLL_UID);
    const rows = (
      await query.findMany({
        where: { audience: { $null: true } },
        select: ["id", "documentId"],
        populate: { departments: { select: ["id"] } },
      })
    ).filter(isNullFlagRow);
    if (rows.length === 0) return;

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

    const departments = await setAudience(query, linked, POLL_AUDIENCE_DEPARTMENTS);
    const siblings = await setAudience(query, siblingRestricted, POLL_AUDIENCE_DEPARTMENTS);
    const all = await setAudience(query, companyWide, POLL_AUDIENCE_ALL);
    const siblingNote =
      siblings > 0 ? `${siblings} to 'departments' (the other row of their poll is restricted), ` : "";
    strapi.log.info(
      `${POLL_AUDIENCE_BACKFILL_LOG} set the audience of ${departments + siblings + all} existing poll row(s): ` +
        `${departments} to 'departments' (they link a department), ${siblingNote}${all} to 'all'`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    strapi.log.warn(
      `${POLL_AUDIENCE_BACKFILL_LOG} could not backfill the audience of existing polls (${reason}); ` +
        `polls that link a department stay restricted by their links, and the next boot retries`,
    );
  }
}
