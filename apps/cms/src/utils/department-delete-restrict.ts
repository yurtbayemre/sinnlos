import { DEPARTMENTS_AUDIENCE } from "./policy-factories";

/**
 * Keeps documents and quick links restricted when a department they target
 * is deleted (FX29 residual; owner answer 2026-09-29 (b): RESTRICT, the
 * poll pattern, the delete is not refused). Called by the department
 * delete lifecycles (api/department/content-types/department/lifecycles.ts)
 * next to the poll hook (utils/poll-department-delete.ts).
 *
 * Documents and quick links are scoped by their `departments` link rows
 * (utils/policy-factories.ts departmentScopedIds): no department =
 * company-wide. Deleting a department cascades its link rows away
 * (`ON DELETE CASCADE` on documents_departments_lnk and
 * quick_links_departments_lnk, both rows of a document), so a row targeted
 * only by that department would silently turn company-wide, guests and
 * anonymous callers included. So before the department rows go, every
 * document and quick-link row that links one of them gets
 * `audience = 'departments'`: it stays targeted, and with no department
 * left only admin_role and editor see it (the read policies' bypass),
 * until a moderator re-targets it. Rows that link another, surviving
 * department stay visible to that department, as before.
 *
 * Draft AND published rows are flagged (each links its own departments):
 * the next publish clones the flagged draft, "Discard changes" the flagged
 * published row, so neither reopens the row.
 *
 * DEFENCE IN DEPTH since the batch 12 review (B12-01). A flag set only
 * here came too late for a write that copied a row before the delete: a
 * publish or "Discard changes" that read the row (Audience `all`, linking
 * the department) before the delete committed recreates it from that copy
 * afterwards, and Strapi drops the missing department from the copy
 * (@strapi/core 5.55.1 transformData, `allowMissingId: true`); an admin
 * form opened before the delete sends its Audience `all` back with the
 * next save. Both turned the row company-wide. Now every row that links a
 * department carries the flag at all times, so every such copy carries it
 * too: the write-time guard (utils/department-audience-guard.ts) sets it
 * in the transaction of each Document Service write, and the boot backfill
 * (utils/department-audience-backfill.ts) on the rows written before it.
 * This hook still flags what they did not (links written outside the
 * Document Service: raw SQL, a previous cms during a rollback).
 *
 * Same mechanics as the poll hook (utils/poll-department-delete.ts), which
 * see for the reasoning:
 *   - BOUNDED: the departments the delete's `where` matches are read in id
 *     pages, the link table of each type in id pages, never more than
 *     DEPARTMENT_DELETE_PAGE ids in one `$in`;
 *   - the link table is read through the model @strapi/database 5.55.1
 *     registers for it (`departments.joinTable` of the type's metadata);
 *     a type without one fails the delete (fail closed) instead of
 *     letting its rows open up;
 *   - runs inside the delete's transaction (the document service wraps
 *     every delete in one): a failed delete rolls the flags back, a failed
 *     flag write fails the delete;
 *   - `updateMany` with an object payload leaves `updatedAt` alone, so the
 *     admin panel keeps showing the rows as Published, not Modified;
 *   - flagging a row that also links a surviving department changes
 *     nothing for its readers (its links restrict it already).
 *
 * CONCURRENT LINKS (Postgres). Under Read Committed a link that another
 * transaction commits after the link scan would still be cascaded away by
 * the delete. A Document Service write commits the flag with its link
 * (the write-time guard); a link written around it would lose it, and the
 * row would turn company-wide. So on Postgres each page of matched
 * departments is locked `FOR UPDATE` before its link tables are read, in
 * the delete's transaction (the query builder joins it). Inserting a link
 * row takes a `FOR KEY SHARE` lock on the department row (the foreign key
 * check), which conflicts with `FOR UPDATE`:
 *   - a link written before the lock: the lock waits for its transaction
 *     if that is still open, and the scan after the lock (a new statement,
 *     so a new snapshot under Read Committed) sees the committed link;
 *   - a link written after the lock: its insert waits for the delete and
 *     then fails the foreign key check (the department is gone), or goes
 *     through unchanged if the delete rolled back.
 * A deadlock with a concurrent edit aborts one of the two transactions,
 * which fails closed either way. SQLite runs one transaction at a time on
 * its single connection, so it needs (and has) no lock. Without a
 * surrounding transaction (a script's db-level delete) the lock ends with
 * its own statement; the admin panel and the content API always delete
 * through the Document Service, which opens one.
 */

export const DEPARTMENT_DELETE_LOG = "[department-delete]";

const DEPARTMENT_UID = "api::department.department";

/** The department-scoped types this hook keeps restricted, with a log label. */
export const DEPARTMENT_SCOPED_TYPES = [
  { uid: "api::document.document", label: "document" },
  { uid: "api::quick-link.quick-link", label: "quick-link" },
] as const;

/** Ids per page and per `$in` of the department and link lookups. */
export const DEPARTMENT_DELETE_PAGE = 500;

export interface LookupQuery {
  findMany(params: Record<string, unknown>): Promise<unknown>;
  updateMany(params: Record<string, unknown>): Promise<{ count?: number } | undefined>;
}

/** The query builder slice that locks department rows (Postgres). */
interface LockQuery {
  select(columns: string[]): LockQuery;
  where(where: Record<string, unknown>): LockQuery;
  forUpdate(): LockQuery;
  execute(): Promise<unknown>;
}

/** The slice of the Strapi instance the hook uses. */
export interface DepartmentDeleteHost {
  db: {
    query(uid: string): LookupQuery;
    /** Joins the ambient transaction on execute() (@strapi/database 5.55.1). */
    queryBuilder(uid: string): LockQuery;
    /** 'postgres' or 'sqlite'. */
    dialect: { client: string };
    /** @strapi/database metadata; read defensively (departmentLinkTable). */
    metadata: { get(uid: string): unknown };
  };
  log: { info(message: string): void };
}

/** A `<type>_departments_lnk` table as the query engine knows it. */
export interface DepartmentLinkTable {
  uid: string;
  rowColumn: string;
  departmentColumn: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * The link table of `<uid>.departments`, or a thrown error (fail closed)
 * that ends with `refusal` (what is refused without it).
 */
export function departmentLinkTable(
  strapi: { db: Pick<DepartmentDeleteHost["db"], "metadata"> },
  uid: string,
  refusal = "refusing to delete a department without keeping its rows restricted",
): DepartmentLinkTable {
  const field = (value: unknown, key: string): unknown =>
    isRecord(value) ? value[key] : undefined;
  const joinTable = field(
    field(field(strapi.db.metadata.get(uid), "attributes"), "departments"),
    "joinTable",
  );
  const table = field(joinTable, "name");
  const rowColumn = field(field(joinTable, "joinColumn"), "name");
  const departmentColumn = field(field(joinTable, "inverseJoinColumn"), "name");
  if (!isName(table) || !isName(rowColumn) || !isName(departmentColumn)) {
    throw new Error(
      `${DEPARTMENT_DELETE_LOG} the link table of ${uid}.departments is unknown; ${refusal}`,
    );
  }
  return { uid: table, rowColumn, departmentColumn };
}

/** The numeric values of `key` in `rows`, in order. */
const numbers = (rows: unknown, key: string): number[] =>
  (Array.isArray(rows) ? rows : [])
    .map((row: unknown) => (isRecord(row) ? row[key] : undefined))
    .filter((value): value is number => typeof value === "number");

/**
 * Sets `audience = 'departments'` on those of `ids` whose flag is NULL or
 * anything else, in chunks. Returns the number of rows changed.
 */
async function setDepartmentsAudience(query: LookupQuery, ids: readonly number[]): Promise<number> {
  let changed = 0;
  for (let start = 0; start < ids.length; start += DEPARTMENT_DELETE_PAGE) {
    const chunk = ids.slice(start, start + DEPARTMENT_DELETE_PAGE);
    const result = await query.updateMany({
      where: {
        id: { $in: chunk },
        $or: [{ audience: { $null: true } }, { audience: { $ne: DEPARTMENTS_AUDIENCE } }],
      },
      data: { audience: DEPARTMENTS_AUDIENCE },
    });
    changed += result?.count ?? 0;
  }
  return changed;
}

/**
 * Flags the rows of `uid` linking any of `departmentIds` (at most one
 * page), or any department at all for `null` (the boot backfill, utils/
 * department-audience-backfill.ts), reading the link table in id pages.
 * Returns the rows changed.
 */
export async function restrictRowsLinking(
  strapi: { db: Pick<DepartmentDeleteHost["db"], "query"> },
  uid: string,
  link: DepartmentLinkTable,
  departmentIds: readonly number[] | null,
): Promise<number> {
  const links = strapi.db.query(link.uid);
  const rows = strapi.db.query(uid);
  let flagged = 0;
  let afterLinkId = 0;
  for (;;) {
    const after = { id: { $gt: afterLinkId } };
    const page = await links.findMany({
      where: departmentIds ? { [link.departmentColumn]: { $in: departmentIds }, ...after } : after,
      select: ["id", link.rowColumn],
      orderBy: { id: "asc" },
      limit: DEPARTMENT_DELETE_PAGE,
    });
    const rowIds = [...new Set(numbers(page, link.rowColumn))];
    if (rowIds.length > 0) flagged += await setDepartmentsAudience(rows, rowIds);
    const linkIds = numbers(page, "id");
    if (linkIds.length < DEPARTMENT_DELETE_PAGE) return flagged;
    afterLinkId = linkIds[linkIds.length - 1];
  }
}

/**
 * Postgres only: locks the department rows `FOR UPDATE` in the ambient
 * transaction, so no link to them can commit between the link scan and
 * the delete (see CONCURRENT LINKS in the module comment).
 */
async function lockDepartments(strapi: DepartmentDeleteHost, ids: number[]): Promise<void> {
  if (strapi.db.dialect.client !== "postgres") return;
  await strapi.db
    .queryBuilder(DEPARTMENT_UID)
    .select(["id"])
    .where({ id: { $in: ids } })
    .forUpdate()
    .execute();
}

/**
 * Flags every document and quick-link row linking a department matched by
 * `where` (the delete's own where; none = every department, as for an
 * unfiltered deleteMany). Returns the rows changed per type uid.
 */
export async function restrictRowsOfDeletedDepartments(
  strapi: DepartmentDeleteHost,
  where: Record<string, unknown> | null | undefined,
): Promise<Record<string, number>> {
  // Every link table first: an unknown one refuses the delete before any write.
  const tables = DEPARTMENT_SCOPED_TYPES.map((type) => ({
    ...type,
    link: departmentLinkTable(strapi, type.uid),
  }));
  const flagged: Record<string, number> = Object.fromEntries(tables.map((type) => [type.uid, 0]));
  const departments = strapi.db.query(DEPARTMENT_UID);
  const filter = where != null && Object.keys(where).length > 0 ? where : null;
  let afterDepartmentId = 0;
  for (;;) {
    const page = { id: { $gt: afterDepartmentId } };
    const departmentIds = numbers(
      await departments.findMany({
        where: filter ? { $and: [filter, page] } : page,
        select: ["id"],
        orderBy: { id: "asc" },
        limit: DEPARTMENT_DELETE_PAGE,
      }),
      "id",
    );
    if (departmentIds.length > 0) {
      await lockDepartments(strapi, departmentIds);
      for (const type of tables) {
        flagged[type.uid] += await restrictRowsLinking(strapi, type.uid, type.link, departmentIds);
      }
    }
    if (departmentIds.length < DEPARTMENT_DELETE_PAGE) break;
    afterDepartmentId = departmentIds[departmentIds.length - 1];
  }
  const changed = tables.filter((type) => flagged[type.uid] > 0);
  if (changed.length > 0) {
    strapi.log.info(
      `${DEPARTMENT_DELETE_LOG} set the audience of ` +
        changed.map((type) => `${flagged[type.uid]} ${type.label} row(s)`).join(" and ") +
        ` to '${DEPARTMENTS_AUDIENCE}': they stay restricted (admins and editors only) ` +
        "until re-targeted",
    );
  }
  return flagged;
}
