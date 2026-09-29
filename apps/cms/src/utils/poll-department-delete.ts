import { setDepartmentsFlag } from "./poll-audience-guard";

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
 * its links, with the flag left at 'all', would turn company-wide, guests
 * included. So before the rows go, every poll row that links one of them
 * gets `audience = 'departments'`: it then stays restricted with no
 * department left, and only admin_role/editor see it (the card asks them
 * to re-select departments).
 *
 * DEFENCE IN DEPTH. Since 2026-09-27d the write-time guard
 * (poll-audience-guard.ts) flags every poll row the moment a write through
 * the Document Service links it, in the same transaction, so a linked row
 * normally is flagged already and this hook changes nothing. That guard
 * also closes the race this hook cannot: under Read Committed a poll
 * linked to the department and committed by another transaction after the
 * scan below is invisible to it, and the cascade then removes its link
 * (Codex review, finding 1); with the guard that poll carries the flag
 * already. What this hook still catches: rows linked outside the Document
 * Service, i.e. by a previous cms during a rollback (it knows no flag) or
 * by raw SQL, as long as their link exists when the scan runs. Rows linked
 * that way after the scan are the accepted residual (§7b).
 *
 * BOUNDED. The departments the delete's `where` matches are read in id
 * pages, and for each page the link table is read in id pages, never more
 * than POLL_DEPARTMENT_DELETE_PAGE ids in one `$in` and never a full result
 * set in memory (an unfiltered deleteMany over many departments used to
 * send them all in one `$in`: SQLite allows at most 32766 bind variables).
 * The link table is queried directly, through the model @strapi/database
 * 5.55.1 registers for it (metadata/relations.js createJoinTable:
 * `metadata.add({ uid: joinTableName, ... })`, its columns as attributes;
 * the poll attribute's `joinTable` names it and both columns), so the
 * lookup goes through the query engine and the ambient transaction.
 *
 * Setting the flag on a row that links a department changes nothing for
 * its readers today (the links already restrict it), so flagging more rows
 * than the delete removes, e.g. when a `delete` where matches several rows,
 * is harmless.
 *
 * Runs inside the delete's transaction when there is one (the document
 * service wraps every delete in one), so a failed delete rolls the flag
 * back. Errors propagate: the department is then not deleted, and its
 * polls stay restricted by their links. A missing link-table model (a
 * Strapi upgrade renamed it) is such an error. `updateMany` with a plain
 * object payload leaves `updatedAt` alone, so the admin panel keeps
 * showing the polls as Published, not Modified.
 */

export const POLL_DEPARTMENT_DELETE_LOG = "[poll-audience]";

const DEPARTMENT_UID = "api::department.department";
const POLL_UID = "api::poll.poll";

/** Ids per page and per `$in` of the department and link lookups. */
export const POLL_DEPARTMENT_DELETE_PAGE = 500;

interface LookupQuery {
  findMany(params: Record<string, unknown>): Promise<unknown[]>;
  updateMany(params: Record<string, unknown>): Promise<{ count?: number } | undefined>;
}

/** The slice of the Strapi instance the hook uses. */
export interface PollDepartmentDeleteHost {
  db: {
    query(uid: string): LookupQuery;
    /** @strapi/database metadata; read defensively (pollDepartmentLinkTable). */
    metadata: { get(uid: string): unknown };
  };
  log: { info(message: string): void };
}

/** polls_departments_lnk as the query engine knows it. */
export interface PollDepartmentLinkTable {
  uid: string;
  pollColumn: string;
  departmentColumn: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The link table of poll.departments, or a thrown error (fail closed). */
export function pollDepartmentLinkTable(
  strapi: Pick<PollDepartmentDeleteHost, "db">,
): PollDepartmentLinkTable {
  const field = (value: unknown, key: string): unknown =>
    isRecord(value) ? value[key] : undefined;
  const joinTable = field(
    field(field(strapi.db.metadata.get(POLL_UID), "attributes"), "departments"),
    "joinTable",
  );
  const uid = field(joinTable, "name");
  const pollColumn = field(field(joinTable, "joinColumn"), "name");
  const departmentColumn = field(field(joinTable, "inverseJoinColumn"), "name");
  if (!isName(uid) || !isName(pollColumn) || !isName(departmentColumn)) {
    throw new Error(
      `${POLL_DEPARTMENT_DELETE_LOG} the link table of poll.departments is unknown; ` +
        "refusing to delete a department without keeping its polls restricted",
    );
  }
  return { uid, pollColumn, departmentColumn };
}

/** The numeric values of `key` in `rows`, in order. */
const numbers = (rows: unknown[], key: string): number[] =>
  rows
    .map((row) => (isRecord(row) ? row[key] : undefined))
    .filter((value): value is number => typeof value === "number");

/**
 * Flags the poll rows linking any of `departmentIds` (at most one page),
 * reading the link table in id pages. Returns the number of rows changed.
 */
async function flagPollsLinkingDepartments(
  strapi: Pick<PollDepartmentDeleteHost, "db">,
  link: PollDepartmentLinkTable,
  departmentIds: number[],
): Promise<number> {
  const links = strapi.db.query(link.uid);
  const polls = strapi.db.query(POLL_UID);
  let flagged = 0;
  let afterLinkId = 0;
  for (;;) {
    const page = await links.findMany({
      where: { [link.departmentColumn]: { $in: departmentIds }, id: { $gt: afterLinkId } },
      select: ["id", link.pollColumn],
      orderBy: { id: "asc" },
      limit: POLL_DEPARTMENT_DELETE_PAGE,
    });
    const pollIds = [...new Set(numbers(page, link.pollColumn))];
    if (pollIds.length > 0) flagged += await setDepartmentsFlag(polls, pollIds);
    const linkIds = numbers(page, "id");
    if (page.length < POLL_DEPARTMENT_DELETE_PAGE || linkIds.length === 0) return flagged;
    afterLinkId = linkIds[linkIds.length - 1];
  }
}

/**
 * Flags every poll row linking a department matched by `where` (the
 * delete's own where; none = every department, as for an unfiltered
 * deleteMany). Returns the number of poll rows whose flag changed.
 */
export async function flagPollsOfDeletedDepartments(
  strapi: PollDepartmentDeleteHost,
  where: Record<string, unknown> | null | undefined,
): Promise<number> {
  const link = pollDepartmentLinkTable(strapi);
  const departments = strapi.db.query(DEPARTMENT_UID);
  const filter = where != null && Object.keys(where).length > 0 ? where : null;
  let flagged = 0;
  let afterDepartmentId = 0;
  for (;;) {
    const page = { id: { $gt: afterDepartmentId } };
    const departmentIds = numbers(
      await departments.findMany({
        where: filter ? { $and: [filter, page] } : page,
        select: ["id"],
        orderBy: { id: "asc" },
        limit: POLL_DEPARTMENT_DELETE_PAGE,
      }),
      "id",
    );
    if (departmentIds.length > 0)
      flagged += await flagPollsLinkingDepartments(strapi, link, departmentIds);
    if (departmentIds.length < POLL_DEPARTMENT_DELETE_PAGE) break;
    afterDepartmentId = departmentIds[departmentIds.length - 1];
  }
  if (flagged > 0) {
    strapi.log.info(
      `${POLL_DEPARTMENT_DELETE_LOG} department delete: set the audience of ${flagged} poll row(s) ` +
        `to 'departments', so they stay restricted without the deleted department(s)`,
    );
  }
  return flagged;
}
