import { POLL_AUDIENCE_DEPARTMENTS } from "./poll-audience";

/**
 * Keeps a poll restricted when a department it targets is deleted
 * (decision 02, fail closed). Called by the department delete lifecycles
 * (api/department/content-types/department/lifecycles.ts).
 *
 * A poll is targeted when its `audience` flag says 'departments' OR it
 * links a department (utils/poll-audience.ts). Deleting a department
 * cascades its link rows away (`ON DELETE CASCADE` on
 * polls_departments_lnk, both poll rows), and since decision 05 a delete is
 * the only way those links can vanish. A poll that was targeted only by
 * its links, with the flag left at 'all' (the enum default the admin panel
 * preselects), would turn company-wide, guests included. So before the
 * rows go, every poll row that links one of them gets
 * `audience = 'departments'`: it then stays restricted with no department
 * left, and only admin_role/editor see it (the card asks them to re-select
 * departments).
 *
 * Setting the flag on a row that links a department changes nothing for
 * its readers today (the links already restrict it), so flagging more rows
 * than the delete removes, e.g. when a `delete` where matches several rows,
 * is harmless.
 *
 * Runs inside the delete's transaction when there is one (the document
 * service wraps every delete in one), so a failed delete rolls the flag
 * back. Errors propagate: the department is then not deleted, and its
 * polls stay restricted by their links. `updateMany` with a plain object
 * payload leaves `updatedAt` alone, so the admin panel keeps showing the
 * polls as Published, not Modified.
 */

export const POLL_DEPARTMENT_DELETE_LOG = "[poll-audience]";

const DEPARTMENT_UID = "api::department.department";
const POLL_UID = "api::poll.poll";

/** Ids per UPDATE statement (keeps well below every driver's bind limit). */
export const POLL_DEPARTMENT_DELETE_CHUNK = 200;

interface FlagQuery {
  findMany(params: Record<string, unknown>): Promise<unknown[]>;
  updateMany(params: Record<string, unknown>): Promise<{ count?: number } | undefined>;
}

/** The slice of the Strapi instance the hook uses. */
export interface PollDepartmentDeleteHost {
  db: { query(uid: string): FlagQuery };
  log: { info(message: string): void };
}

const rowIds = (rows: unknown[]): number[] =>
  rows
    .map((row) => (typeof row === "object" && row !== null ? (row as { id?: unknown }).id : undefined))
    .filter((id): id is number => typeof id === "number");

/**
 * Flags every poll row linking a department matched by `where` (the
 * delete's own where; none = every department, as for an unfiltered
 * deleteMany). Returns the number of poll rows whose flag changed.
 */
export async function flagPollsOfDeletedDepartments(
  strapi: PollDepartmentDeleteHost,
  where: Record<string, unknown> | null | undefined,
): Promise<number> {
  const departmentIds = rowIds(
    await strapi.db.query(DEPARTMENT_UID).findMany({ where: where ?? {}, select: ["id"] }),
  );
  if (departmentIds.length === 0) return 0;

  const polls = strapi.db.query(POLL_UID);
  // `id` in the select: the relation filter makes the query DISTINCT over
  // the selected columns, which here is exactly one row per poll row.
  const pollIds = rowIds(
    await polls.findMany({
      where: { departments: { id: { $in: departmentIds } } },
      select: ["id"],
    }),
  );
  if (pollIds.length === 0) return 0;

  let flagged = 0;
  for (let start = 0; start < pollIds.length; start += POLL_DEPARTMENT_DELETE_CHUNK) {
    const chunk = pollIds.slice(start, start + POLL_DEPARTMENT_DELETE_CHUNK);
    const result = await polls.updateMany({
      where: {
        id: { $in: chunk },
        $or: [{ audience: { $null: true } }, { audience: { $ne: POLL_AUDIENCE_DEPARTMENTS } }],
      },
      data: { audience: POLL_AUDIENCE_DEPARTMENTS },
    });
    flagged += result?.count ?? 0;
  }
  if (flagged > 0) {
    strapi.log.info(
      `${POLL_DEPARTMENT_DELETE_LOG} department delete: set the audience of ${flagged} poll row(s) ` +
        `to 'departments', so they stay restricted without the deleted department(s)`,
    );
  }
  return flagged;
}
