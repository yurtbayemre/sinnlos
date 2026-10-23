import type { createStrapiStub } from "../test/strapi-stub.test.helper";

/**
 * Adds the two pieces of the query layer the v0.28 janitors read their
 * DISTINCT targets through (`db.metadata.get`, `db.getConnection(table)
 * .distinct("<column> as <attribute>", …)`) to a Strapi stub, over the
 * stub's own rows: one result row per distinct combination of the named
 * attributes. Column names are the janitors' snake_case fallbacks; the
 * stub rows hold attributes, so only the alias after `as` is read. The
 * real knex DISTINCT runs in integration/retention-v028.integration.test.ts.
 */
export function withDistinct<S extends ReturnType<typeof createStrapiStub>>(
  strapi: S,
  tables: Record<string, string>,
): S {
  const uidOf = (table: string) => Object.keys(tables).find((uid) => tables[uid] === table);
  Object.assign(strapi.db, {
    metadata: {
      get: (uid: string) => ({ tableName: tables[uid] ?? uid, attributes: {} }),
    },
    getConnection: (table: string) => ({
      distinct: async (...columns: string[]) => {
        const uid = uidOf(table);
        if (!uid) throw new Error(`no stub table ${table}`);
        const aliases = columns.map((column) => column.split(" as ")[1] ?? column);
        const seen = new Map<string, Record<string, unknown>>();
        for (const row of strapi.tables[uid] ?? []) {
          const picked = Object.fromEntries(aliases.map((alias) => [alias, row[alias] ?? null]));
          seen.set(JSON.stringify(picked), picked);
        }
        return [...seen.values()];
      },
    }),
  });
  return strapi;
}
