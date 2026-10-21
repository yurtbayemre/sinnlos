import { lockDocument, type DocumentLockHost } from "./document-lock";
import { refuseKeys } from "./write-allowlist";

const DEPARTMENT_UID = "api::department.department";

/**
 * The reserved version row that serialises department names (like the wiki
 * structure lock). Taken inside the write's transaction, after the
 * department's own version row (the document lock's): `sinnlos::` sorts
 * after every `api::` uid, the order of utils/wiki-structure-lock.ts.
 */
export const DEPARTMENT_NAMES_LOCK_UID = "sinnlos::department-names";
export const DEPARTMENT_NAMES_LOCK_DOCUMENT_ID = "global";

type Row = Record<string, unknown>;

export interface DepartmentNamesHost {
  db: {
    inTransaction(): boolean;
    query(uid: string): {
      findMany(params: Row): Promise<unknown>;
      count(params: Row): Promise<number>;
    };
  };
}

/**
 * Refuses (400 `name`/`taken`) a department name another department has in
 * any case (v0.22, Codex review): Entra's department sync matches names
 * with `$eqi` and clears an ambiguous match, and Strapi's own unique check
 * is case-sensitive without a database index. Both foldings count: the
 * database's (what Entra uses; Postgres folds per character, "ΟΣ" = "οσ")
 * and JavaScript's (SQLite's LOWER folds ASCII only, "Ä" vs "ä").
 *
 * Called from the department's beforeCreate/beforeUpdate, so every writer
 * passes it: the web (org gate), the admin panel, the Document Service in
 * scripts. `except` is the update's `where` (its own row). Under the names
 * lock inside a transaction (every Document Service write has one), so two
 * creates or renames to one name cannot both pass.
 */
export async function assertFreeDepartmentName(
  strapi: DepartmentNamesHost,
  data: Row | null | undefined,
  except?: Row | null,
): Promise<void> {
  const name = data?.name;
  if (typeof name !== "string" || name === "") return;
  if (strapi.db.inTransaction()) {
    await lockDocument(
      strapi as unknown as DocumentLockHost,
      DEPARTMENT_NAMES_LOCK_UID,
      DEPARTMENT_NAMES_LOCK_DOCUMENT_ID,
    );
  }
  const departments = strapi.db.query(DEPARTMENT_UID);
  const own = except
    ? ((await departments.findMany({ where: except, select: ["id"] })) as Row[]).map(
        (row) => row.id,
      )
    : [];
  const others = own.length > 0 ? { id: { $notIn: own } } : {};
  const wanted = name.toLowerCase();
  const rows = (await departments.findMany({ where: others, select: ["name"] })) as Row[];
  const clash =
    rows.some((row) => typeof row.name === "string" && row.name.toLowerCase() === wanted) ||
    (await departments.count({ where: { ...others, name: { $eqi: name } } })) > 0;
  if (clash) refuseKeys(["name"], { name: "taken" });
}
