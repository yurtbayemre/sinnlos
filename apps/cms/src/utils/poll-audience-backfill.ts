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
 * content, exactly what the web form would have set for it. Runs before
 * the draft-twin repair (utils/draft-twins.ts), so a draft cloned from a
 * published row copies the backfilled flag. `updateMany` leaves `updatedAt`
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

export async function backfillPollAudience(strapi: PollAudienceBackfillHost): Promise<void> {
  try {
    const query = strapi.db.query(POLL_UID);
    const rows = (
      await query.findMany({
        where: { audience: { $null: true } },
        select: ["id"],
        populate: { departments: { select: ["id"] } },
      })
    ).filter(isNullFlagRow);
    if (rows.length === 0) return;

    const targeted = rows.filter((row) => (row.departments ?? []).length > 0).map((row) => row.id);
    const companyWide = rows.filter((row) => (row.departments ?? []).length === 0).map((row) => row.id);

    const departments = await setAudience(query, targeted, POLL_AUDIENCE_DEPARTMENTS);
    const all = await setAudience(query, companyWide, POLL_AUDIENCE_ALL);
    strapi.log.info(
      `${POLL_AUDIENCE_BACKFILL_LOG} set the audience of ${departments + all} existing poll row(s): ` +
        `${departments} to 'departments' (they link a department), ${all} to 'all'`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    strapi.log.warn(
      `${POLL_AUDIENCE_BACKFILL_LOG} could not backfill the audience of existing polls (${reason}); ` +
        `polls that link a department stay restricted by their links, and the next boot retries`,
    );
  }
}
