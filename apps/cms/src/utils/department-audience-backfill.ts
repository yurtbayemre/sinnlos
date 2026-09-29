import {
  DEPARTMENT_SCOPED_TYPES,
  departmentLinkTable,
  restrictRowsLinking,
  type LookupQuery,
} from "./department-delete-restrict";
import { DEPARTMENT_AUDIENCE_LOG } from "./department-audience-guard";
import { DEPARTMENTS_AUDIENCE } from "./policy-factories";

/**
 * Boot backfill of the document and quick-link audience flag (FX29
 * residual; batch 12 review B12-01), run at every boot before the server
 * serves: every row, draft and published alike, that links a department
 * gets `audience = 'departments'`. Together with the write-time guard
 * (utils/department-audience-guard.ts) that makes the flag an invariant: a
 * row that links a department carries it, so a copy of the row that a
 * publish, a "Discard changes" or an open admin form took before a
 * department delete carries it too (the guard's header explains why the
 * delete hook alone cannot keep that row restricted).
 *
 * WHAT IT CHANGES. The first boot of batch 12 adds the column and leaves
 * every existing row NULL, and rows written before the guard say `all` (the
 * schema default); both read by their links alone, so a row that links a
 * department is restricted already and the flag changes nothing for its
 * readers. Raise only: it never sets `all`, never touches a row without a
 * link and never lowers a flag, so a row a department delete left flagged
 * without departments stays restricted. Later boots find nothing to change
 * (the guard flags every new link); they re-read the link tables and write
 * nothing, and flag what a writer around the Document Service linked in
 * the meantime (a previous cms during a rollback, raw SQL).
 *
 * HOW. Per type, the link table (`documents_departments_lnk`,
 * `quick_links_departments_lnk`, through the model @strapi/database 5.55.1
 * registers for it) is read in id pages of DEPARTMENT_DELETE_PAGE rows, and
 * each page's rows are flagged by one `updateMany` that only matches rows
 * not flagged yet (the department delete hook's own paging,
 * restrictRowsLinking). `updateMany` with an object payload leaves
 * `updatedAt` alone, so the admin panel keeps showing Published, not
 * Modified. A type whose link table is unknown fails the boot.
 *
 * ATOMIC AND FAIL CLOSED, as the poll backfill (utils/poll-audience-
 * backfill.ts): both types in ONE transaction; any error rolls all of it
 * back and is rethrown as a `[department-audience]` error, which stops the
 * boot before the server listens (@strapi/core 5.55.1 Strapi.js start →
 * stopWithError). The cms does not serve while a linked row may lack its
 * flag; every start retries. The operator steps are in docs/DEPLOYMENT.md.
 */

/** The slice of the Strapi instance the backfill uses. */
export interface DepartmentAudienceBackfillHost {
  db: {
    query(uid: string): LookupQuery;
    transaction<T>(callback: () => Promise<T>): Promise<T>;
    /** @strapi/database metadata; read defensively (departmentLinkTable). */
    metadata: { get(uid: string): unknown };
  };
  log: { info(message: string): void };
}

/**
 * Runs the backfill. Resolves once every linked row carries the flag
 * (logging one line when it set any); rejects with a `[department-audience]`
 * error, after the transaction rolled back, when anything failed.
 */
export async function backfillDepartmentAudience(
  strapi: DepartmentAudienceBackfillHost,
): Promise<void> {
  let flagged: Array<{ label: string; count: number }>;
  try {
    flagged = await strapi.db.transaction(async () => {
      const refusal = "the backfill cannot find the rows that link a department";
      // Every link table first: an unknown one fails before any write.
      const types = DEPARTMENT_SCOPED_TYPES.map((type) => ({
        ...type,
        link: departmentLinkTable(strapi, type.uid, refusal),
      }));
      const counts: Array<{ label: string; count: number }> = [];
      for (const type of types) {
        counts.push({
          label: type.label,
          count: await restrictRowsLinking(strapi, type.uid, type.link, null),
        });
      }
      return counts;
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${DEPARTMENT_AUDIENCE_LOG} could not backfill the audience of documents and quick links (${reason}); ` +
        "nothing was changed (the transaction rolled back), and the cms does not start, because a row " +
        "that links a department without the flag can turn company-wide when the department is deleted. " +
        "Fix the cause and start the cms again (every start retries), or roll back (docs/DEPLOYMENT.md)",
    );
  }
  const changed = flagged.filter((type) => type.count > 0);
  if (changed.length === 0) return;
  strapi.log.info(
    `${DEPARTMENT_AUDIENCE_LOG} set the audience of ` +
      changed.map((type) => `${type.count} existing ${type.label} row(s)`).join(" and ") +
      ` to '${DEPARTMENTS_AUDIENCE}' (they link a department)`,
  );
}
