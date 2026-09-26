/**
 * Boot guard for the department/team draft & publish switch (decision 05,
 * docs/DEPLOYMENT.md "One-time: org draft/publish off").
 *
 * department and team run with draftAndPublish OFF: every org unit is ONE
 * row with a stable id (invariant I-ORG, docs/architecture.md §5.35), so the
 * numeric org-scope comparisons (visible-ids.ts, announcement-audience.ts,
 * the FX07 write policies, ...) hold. A database from the draft & publish era
 * can still carry draft rows (`published_at IS NULL`): a draft twin next to
 * its published row, or a unit that was never published.
 *
 * Booting on such a database destroys data. When the stored schema still
 * says draftAndPublish true and the code says false, Strapi runs
 * `DELETE FROM <table> WHERE published_at IS NULL` (@strapi/core 5.55.1
 * dist/migrations/draft-publish.js:48-65). That runs in the
 * `content-types.beforeSync` hook (Strapi.js:358), with no transaction,
 * before schema sync and before any user migration (which run inside
 * db.schema.sync, @strapi/database dist/schema/index.js:73-78). Never-published
 * units are gone, every link row of a draft goes with it (FK ON DELETE
 * CASCADE: users lose their department, draft content loses its targeting),
 * and media rows in files_related_mph are left orphaned.
 *
 * The user register() lifecycle runs before all of that (Strapi.js:333,
 * bootstrap/db.init/hook from :338), with the content types already loaded
 * (providers/registries.js:28) and the knex connection already built (the
 * Database constructor), so this check can refuse the boot first. A throw
 * here ends in stopWithError → process.exit(1) (Strapi.js:204-214, :304-319);
 * under `restart: unless-stopped` that is a restart loop with the data
 * intact. The fix is always infra/migrations/org-dp/migrate.sql (idempotent).
 *
 * Also catches the two unsafe paths after the migration: restoring a
 * pre-migration dump onto the new image, and rolling forward after an image
 * rollback (the old image's enable hook re-clones a draft of every row).
 *
 * Permanent, no env switch. Cost per boot: two hasTable checks and two
 * counts. getSchemaConnection()/getConnection() apply DATABASE_SCHEMA
 * (@strapi/database dist/index.js:101-105, :128-131); plain knex(table)
 * would not.
 *
 * Side effect: register() now needs a reachable database. The Strapi CLI
 * commands that run only register() and never load() used to work without
 * one: `strapi ts:generate-types`, `strapi report` and the `…:list`
 * commands except routes:list (content-types, components, controllers,
 * hooks, middlewares, policies, services; @strapi/strapi 5.55.1
 * dist/src/cli/commands/ts/generate-types.js:19, content-types/list.js:16).
 * They now need the configured database up, or a SQLite .env
 * (config/database.ts defaults to postgres). `strapi build` never calls
 * register() and is unaffected; nothing in package.json, CI or the
 * Dockerfile runs the others.
 */

export const ORG_DP_UIDS = ["api::department.department", "api::team.team"] as const;

/** The column Strapi's own disable hook deletes by. */
const PUBLISHED_AT_COLUMN = "published_at";

export const ORG_DP_RUNBOOK = 'docs/DEPLOYMENT.md "One-time: org draft/publish off"';

interface OrgModel {
  collectionName?: string;
  options?: { draftAndPublish?: unknown };
}

type CountRow = Record<string, unknown>;

/** The slice of the Strapi instance the guard reads. */
export interface OrgDpGuardHost {
  getModel(uid: string): OrgModel | undefined;
  db: {
    getSchemaConnection(): { hasTable(table: string): PromiseLike<boolean> };
    getConnection(table: string): {
      whereNull(column: string): { count(spec: { n: string }): PromiseLike<CountRow[]> };
    };
  };
}

export function orgDraftRowsMessage(table: string, count: number): string {
  return (
    `[org-dp] ${table} still holds ${count} draft row(s). Booting would let Strapi delete ` +
    `them (draftAndPublish true -> false). Run infra/migrations/org-dp/migrate.sql first, ` +
    `see ${ORG_DP_RUNBOOK}. Local SQLite: delete apps/cms/.tmp/data.db and reseed.`
  );
}

/**
 * Resolves when no department/team table holds a row with
 * `published_at IS NULL`; rejects with an `[org-dp]` error otherwise.
 * Skips a type whose model still has draftAndPublish on (nothing to lose)
 * and a table that does not exist yet (fresh install). Checks both types
 * before deciding, and names every table that blocks.
 */
export async function assertNoOrgDrafts(strapi: OrgDpGuardHost): Promise<void> {
  const problems: string[] = [];
  for (const uid of ORG_DP_UIDS) {
    const model = strapi.getModel(uid);
    if (model?.options?.draftAndPublish !== false) continue;
    const table = model.collectionName;
    if (!table) throw new Error(`[org-dp] ${uid} has no collectionName`);
    if (!(await strapi.db.getSchemaConnection().hasTable(table))) continue;
    const [row] = await strapi.db
      .getConnection(table)
      .whereNull(PUBLISHED_AT_COLUMN)
      .count({ n: "*" });
    const count = Number(row?.n ?? 0);
    if (count > 0) problems.push(orgDraftRowsMessage(table, count));
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
}
