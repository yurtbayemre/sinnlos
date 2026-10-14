import { SCHEDULED_UIDS, UNPUBLISH_SCHEDULED_UIDS } from "../utils/authoring-uids";
import { CONTENT_VERSION_UID } from "../utils/document-lock";
import { WIKI_REVISION_UID } from "../utils/wiki-revisions";

/**
 * The database indexes of v2 authoring (decision 06 §D, §G; batch 15 plan
 * item 2), ensured at every boot like bootstrap/entra-identity-index.ts,
 * because a `unique` in schema.json is no database index (the Kurzliste row
 * "Schema") and schema.json declares no partial index:
 *
 *   - content_versions_target_uq: UNIQUE (target_uid, target_document_id).
 *     The document lock's `insert … on conflict do nothing` needs it (two
 *     first mutations of one document must end with ONE version row), so
 *     without it the cms does not start;
 *   - <table>_publish_at_partial_idx on each scheduled table, and
 *     <table>_unpublish_at_partial_idx on documents and quick_links:
 *     `(publish_at) WHERE publish_at IS NOT NULL`, so the scheduler's
 *     every-minute "what is due" reads touch the few scheduled rows only;
 *   - wiki_revisions_page_document_id_idx: (page_document_id), the anchor
 *     every history read and the boot backfill's baseline check go by
 *     (batch 16, DA03; utils/wiki-revisions.ts). Plain, not unique.
 *
 * `CREATE … INDEX IF NOT EXISTS`, on Postgres and SQLite. Strapi's schema
 * sync never drops an index it did not create (@strapi/database
 * schema/diff.js diffTableIndexes), and a SQLite table rebuild that lost one
 * gets it back on the same boot, because bootstrap() runs after the sync.
 * Table and column names come from Strapi's metadata. Logs one line naming
 * the indexes a boot created (the first boot of batch 15); a later boot
 * finds them and logs nothing. Any failure throws: the cms does not start.
 */

export const DOCUMENT_INDEXES_LOG = "[document-indexes]";

export const CONTENT_VERSION_INDEX = "content_versions_target_uq";

interface ModelMeta {
  tableName: string;
  attributes: Record<string, { columnName?: string } | undefined>;
}

/** The slice of the Strapi instance the indexes need. */
export interface DocumentIndexHost {
  db: {
    connection: { raw(sql: string, bindings?: readonly unknown[]): PromiseLike<unknown> };
    dialect: { client: string };
    getSchemaName(): string | undefined | null;
    metadata: { get(uid: string): ModelMeta | undefined };
  };
  log: { info(message: string): void };
}

export interface IndexSpec {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
  /** The column that must be NOT NULL for a row to be indexed (partial index). */
  notNull?: string;
}

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

/** The DDL of one index; throws for a client other than Postgres or SQLite. */
export function indexSql(client: string, schema: string, spec: IndexSpec): string {
  const table =
    client === "postgres"
      ? `${quote(schema)}.${quote(spec.table)}`
      : client === "sqlite"
        ? quote(spec.table)
        : null;
  if (table === null) {
    throw new Error(`database client ${client} is not supported (Postgres or SQLite)`);
  }
  const columns = spec.columns.map(quote).join(", ");
  const where = spec.notNull ? ` WHERE ${quote(spec.notNull)} IS NOT NULL` : "";
  return (
    `CREATE ${spec.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quote(spec.name)} ` +
    `ON ${table} (${columns})${where}`
  );
}

function metaOf(strapi: DocumentIndexHost, uid: string): ModelMeta {
  const meta = strapi.db.metadata.get(uid);
  if (!meta?.tableName) throw new Error(`the model ${uid} is not loaded`);
  return meta;
}

const columnOf = (meta: ModelMeta, attribute: string, fallback: string) =>
  meta.attributes?.[attribute]?.columnName ?? fallback;

/** Every index of this module, from Strapi's metadata. */
export function documentIndexSpecs(strapi: DocumentIndexHost): IndexSpec[] {
  const versions = metaOf(strapi, CONTENT_VERSION_UID);
  const specs: IndexSpec[] = [
    {
      name: CONTENT_VERSION_INDEX,
      table: versions.tableName,
      columns: [
        columnOf(versions, "targetUid", "target_uid"),
        columnOf(versions, "targetDocumentId", "target_document_id"),
      ],
      unique: true,
    },
  ];
  const partial = (uid: string, attribute: string, fallback: string) => {
    const meta = metaOf(strapi, uid);
    const column = columnOf(meta, attribute, fallback);
    specs.push({
      name: `${meta.tableName}_${column}_partial_idx`,
      table: meta.tableName,
      columns: [column],
      unique: false,
      notNull: column,
    });
  };
  for (const uid of SCHEDULED_UIDS) partial(uid, "publishAt", "publish_at");
  for (const uid of UNPUBLISH_SCHEDULED_UIDS) partial(uid, "unpublishAt", "unpublish_at");
  const revisions = metaOf(strapi, WIKI_REVISION_UID);
  const anchor = columnOf(revisions, "pageDocumentId", "page_document_id");
  specs.push({
    name: `${revisions.tableName}_${anchor}_idx`,
    table: revisions.tableName,
    columns: [anchor],
    unique: false,
  });
  return specs;
}

/** Rows out of a knex raw() result: an array (SQLite) or `{ rows }` (pg). */
function rawRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

async function existingIndexes(
  strapi: DocumentIndexHost,
  schema: string,
  names: string[],
): Promise<Set<string>> {
  const placeholders = names.map(() => "?").join(", ");
  const result =
    strapi.db.dialect.client === "postgres"
      ? await strapi.db.connection.raw(
          `SELECT indexname AS name FROM pg_indexes WHERE schemaname = ? AND indexname IN (${placeholders})`,
          [schema, ...names],
        )
      : await strapi.db.connection.raw(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${placeholders})`,
          names,
        );
  return new Set(rawRows(result).map((row) => String(row.name)));
}

/**
 * Creates the missing indexes (see the module comment). Returns the names
 * it created. Throws, naming the index, when one cannot be ensured.
 */
export async function ensureDocumentIndexes(strapi: DocumentIndexHost): Promise<string[]> {
  const client = strapi.db.dialect.client;
  const schema = strapi.db.getSchemaName() || "public";
  let specs: IndexSpec[];
  try {
    specs = documentIndexSpecs(strapi);
  } catch (error) {
    throw new Error(
      `${DOCUMENT_INDEXES_LOG} cannot name the indexes: ${(error as Error).message}; refusing to start`,
    );
  }
  const present = await existingIndexes(
    strapi,
    schema,
    specs.map((spec) => spec.name),
  );
  const created: string[] = [];
  for (const spec of specs) {
    if (present.has(spec.name)) continue;
    try {
      await strapi.db.connection.raw(indexSql(client, schema, spec));
    } catch (error) {
      throw new Error(
        `${DOCUMENT_INDEXES_LOG} could not create the index ${spec.name} on ${spec.table}: ` +
          `${(error as Error).message}. The cms does not start without it (the document lock ` +
          "needs content_versions_target_uq; the scheduler reads through the partial indexes; " +
          "the wiki history through the revision anchor index).",
      );
    }
    created.push(spec.name);
  }
  if (created.length > 0) {
    strapi.log.info(
      `${DOCUMENT_INDEXES_LOG} created ${created.length} index(es): ${created.join(", ")}`,
    );
  }
  return created;
}
