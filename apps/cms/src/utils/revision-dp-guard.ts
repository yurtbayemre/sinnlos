/**
 * Boot guard for the wiki-revision draft & publish switch (decision 06 §J4,
 * Migration §2; batch 16 lane 16D; the runbook
 * infra/migrations/wiki-revision-dp/README.md). The decision-05 pattern of
 * utils/org-dp-guard.ts, for one more type.
 *
 * wiki-revision runs with draftAndPublish OFF from batch 16 on: a revision
 * is one row, anchored by `pageDocumentId` (utils/wiki-revisions.ts). A
 * database from before can hold revision rows with `published_at IS NULL`:
 *   - after a rollback to batch 15.1 (or older), whose boot turned draft &
 *     publish back on and cloned one draft twin per revision row
 *     (@strapi/core 5.57 dist/migrations/draft-publish.js `enable`, through
 *     discardDraft; framework-contract.test.ts);
 *   - from a revision created in the admin panel before batch 15.1 hid the
 *     type, or from raw SQL.
 * Booting the new model on such a database destroys them: Strapi's
 * `disable` runs `DELETE FROM wiki_revisions WHERE published_at IS NULL` in
 * the `content-types.beforeSync` hook, with no transaction, before the
 * schema sync. The user register() lifecycle runs before that hook
 * (core 5.57 Strapi.js; framework-contract.test.ts pins the order), so this
 * check, right after the org guard, refuses the boot first. The throw ends
 * in a restart loop with the data intact; infra/deploy.sh refuses such a
 * deploy before its backup already (the revision probe). The fix is always
 * infra/migrations/wiki-revision-dp/migrate.sql: it deletes the identical
 * twins a rollback made, promotes draft-only rows and stops on anything it
 * cannot decide.
 *
 * Skips a model that still has draft & publish on (nothing to lose) and a
 * table that does not exist yet (fresh install). Permanent, no env switch;
 * one hasTable and one count per boot. getSchemaConnection()/getConnection()
 * apply DATABASE_SCHEMA, as in the org guard.
 */
import type { OrgDpGuardHost } from "./org-dp-guard";

export const REVISION_DP_UID = "api::wiki-revision.wiki-revision";

export const REVISION_DP_RUNBOOK = "infra/migrations/wiki-revision-dp/README.md";

/** The column Strapi's own disable hook deletes by. */
const PUBLISHED_AT_COLUMN = "published_at";

/** The slice of the Strapi instance the guard reads (the org guard's). */
export type RevisionDpGuardHost = OrgDpGuardHost;

export function revisionDraftRowsMessage(table: string, count: number): string {
  return (
    `[revision-dp] ${table} still holds ${count} draft row(s). Booting would let Strapi delete ` +
    `them (draftAndPublish true -> false). Run infra/migrations/wiki-revision-dp/migrate.sql ` +
    `first, see ${REVISION_DP_RUNBOOK}. Local SQLite: delete apps/cms/.tmp/data.db and reseed.`
  );
}

/**
 * Resolves when wiki_revisions holds no row with `published_at IS NULL`;
 * rejects with a `[revision-dp]` error otherwise (see the module comment).
 */
export async function assertNoRevisionDrafts(strapi: RevisionDpGuardHost): Promise<void> {
  const model = strapi.getModel(REVISION_DP_UID);
  if (model?.options?.draftAndPublish !== false) return;
  const table = model.collectionName;
  if (!table) throw new Error(`[revision-dp] ${REVISION_DP_UID} has no collectionName`);
  if (!(await strapi.db.getSchemaConnection().hasTable(table))) return;
  const [row] = await strapi.db.getConnection(table).whereNull(PUBLISHED_AT_COLUMN).count({
    n: "*",
  });
  const count = Number(row?.n ?? 0);
  if (count > 0) throw new Error(revisionDraftRowsMessage(table, count));
}
