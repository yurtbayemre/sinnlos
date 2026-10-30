/**
 * Test support: the REAL Strapi document service (@strapi/core
 * createDocumentService, with its middleware manager) over the REAL query
 * engine (@strapi/database) on a throwaway SQLite file, for a handful of
 * content types. framework-contract.test.ts pins the same wiring against
 * the installed packages; this helper lets the document layer's unit tests
 * (utils/document-lock.test.ts, utils/audit.test.ts, …) run their
 * middlewares around real actions and real rows without booting the cms.
 *
 * The content types are given as registry entries (uid, collection name,
 * attributes). `appContentType(uid)` reads an app schema.json from src/api;
 * `minimalType(uid, attributes)` builds one by hand, e.g. a guarded uid
 * with only a title.
 *
 * Named *.test.helper.ts: the Strapi build skips it, Vitest does not collect it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";

import {
  openSqliteEngine,
  requirePackageFile,
  strapiPackageDir,
  type QueryEngine,
  type SqliteEngine,
} from "./sqlite-engine.test.helper";

/** A content type as the registry hands it to the document service. */
export interface RegistryContentType {
  uid: string;
  modelType: "contentType";
  kind: "collectionType";
  modelName: string;
  globalId: string;
  collectionName: string;
  info: { singularName: string; pluralName: string; displayName: string };
  options: { draftAndPublish: boolean };
  pluginOptions?: Record<string, unknown>;
  attributes: Record<string, Record<string, unknown>>;
}

const BOOKKEEPING = {
  createdAt: { type: "datetime" },
  updatedAt: { type: "datetime" },
  publishedAt: { type: "datetime", configurable: false, writable: true, visible: false },
  locale: { type: "string" },
};

/** A registry entry from a uid, a table and attributes (bookkeeping added). */
export function minimalType(
  uid: string,
  collectionName: string,
  attributes: Record<string, Record<string, unknown>>,
  draftAndPublish = true,
): RegistryContentType {
  const singular = uid.split(".").pop() ?? uid;
  return {
    uid,
    modelType: "contentType",
    kind: "collectionType",
    modelName: singular,
    globalId: singular.replace(/(^|-)(\w)/g, (_m, _d, c: string) => c.toUpperCase()),
    collectionName,
    info: { singularName: singular, pluralName: collectionName, displayName: singular },
    options: { draftAndPublish },
    attributes: { ...attributes, ...BOOKKEEPING },
  };
}

/**
 * An app content type from its schema.json, keeping only the attributes
 * `keep` accepts (relations to types the test does not load must go).
 */
export function appContentType(
  uid: string,
  keep: (name: string, attribute: Record<string, unknown>) => boolean = (_name, attribute) =>
    attribute.type !== "relation" && attribute.type !== "media",
): RegistryContentType {
  const [, rest] = uid.split("::");
  const [api, type] = rest.split(".");
  const schema = JSON.parse(
    readFileSync(join(__dirname, "..", "api", api, "content-types", type, "schema.json"), "utf8"),
  ) as {
    collectionName: string;
    options?: { draftAndPublish?: boolean };
    pluginOptions?: Record<string, unknown>;
    attributes: Record<string, Record<string, unknown>>;
  };
  const attributes = Object.fromEntries(
    Object.entries(schema.attributes).filter(([name, attribute]) => keep(name, attribute)),
  );
  return {
    ...minimalType(
      uid,
      schema.collectionName,
      attributes,
      schema.options?.draftAndPublish === true,
    ),
    pluginOptions: schema.pluginOptions,
  };
}

/** A Document Service middleware as the app writes them. */
export type TestMiddleware = (
  context: { uid?: string; action?: string; params?: unknown; contentType?: unknown },
  next: () => Promise<unknown>,
) => Promise<unknown>;

/** A row as the tests read it (any column). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read loosely in tests
export type TestRow = Record<string, any>;

/** The repository of one uid (the actions the tests call). */
export interface TestDocuments {
  create(params: Record<string, unknown>): Promise<TestRow>;
  update(params: Record<string, unknown>): Promise<TestRow | null>;
  findOne(params: Record<string, unknown>): Promise<TestRow | null>;
  findMany(params?: Record<string, unknown>): Promise<TestRow[]>;
  publish(params: Record<string, unknown>): Promise<{ documentId: string; entries: TestRow[] }>;
  unpublish(params: Record<string, unknown>): Promise<{ documentId: string; entries: TestRow[] }>;
  discardDraft(
    params: Record<string, unknown>,
  ): Promise<{ documentId: string; entries: TestRow[] }>;
  clone(params: Record<string, unknown>): Promise<{ documentId: string; entries: TestRow[] }>;
  delete(params: Record<string, unknown>): Promise<{ documentId: string; entries: TestRow[] }>;
}

export type TestDocumentService = ((uid: string) => TestDocuments) & {
  use(middleware: TestMiddleware): () => void;
};

/** The fake `strapi` the document service runs against (also the global). */
export interface TestStrapiInstance {
  db: QueryEngine & TestRow;
  documents: TestDocumentService;
  contentType(uid: string): RegistryContentType | undefined;
  getModel(uid: string): RegistryContentType | undefined;
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  requestContext: { get(): unknown };
  [key: string]: unknown;
}

export interface OpenDocumentService {
  strapi: TestStrapiInstance;
  service: TestDocumentService;
  db: QueryEngine & TestRow;
  engine: SqliteEngine;
  close(): Promise<void>;
}

/** Builds the document service for `types` on a fresh SQLite file. */
export async function openDocumentService(
  types: readonly RegistryContentType[],
): Promise<OpenDocumentService> {
  const coreDir = strapiPackageDir("@strapi/core");
  const { transformContentTypesToModels } = requirePackageFile<{
    transformContentTypesToModels(contentTypes: unknown[], identifiers: unknown): unknown[];
  }>(coreDir, "dist/utils/transform-content-types-to-models.js");
  const engine = await openSqliteEngine((identifiers) =>
    transformContentTypesToModels([...types], identifiers),
  );
  const db = engine.db as QueryEngine & TestRow;
  const contentTypes: Record<string, RegistryContentType> = Object.fromEntries(
    types.map((type) => [type.uid, type]),
  );
  const fake: TestRow = {
    db,
    contentTypes,
    components: {},
    contentType: (uid: string) => contentTypes[uid],
    getModel: (uid: string) => contentTypes[uid],
    config: { get: (_key: string, fallback?: unknown) => fallback },
    // hasListeners (5.60): true keeps the entry-event path (re-read, emit) running.
    eventHub: { emit: async () => undefined, hasListeners: () => true },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    requestContext: { get: () => undefined },
  };
  // i18n's provider, as booted (framework-contract.test.ts pins it): no
  // type here is localized.
  const i18nDir = strapiPackageDir("@strapi/i18n");
  const contentTypesService = requirePackageFile<() => unknown>(
    i18nDir,
    "dist/server/services/content-types.js",
  )();
  const localesService = {
    getDefaultLocale: async () => "en",
    find: async () => [{ code: "en", name: "English (en)" }],
  };
  fake.plugin = (name: string) =>
    name === "i18n"
      ? {
          service: (service: string) => {
            if (service === "content-types") return contentTypesService;
            if (service === "locales") return localesService;
            throw new Error(`i18n service ${service} not stubbed`);
          },
        }
      : undefined;
  const { createLocalizationService } = requirePackageFile<{
    createLocalizationService(): { register(provider: unknown): void };
  }>(coreDir, "dist/services/localization.js");
  const { createLocalizationProvider } = requirePackageFile<{
    createLocalizationProvider(strapi: unknown): unknown;
  }>(i18nDir, "dist/server/localization.js");
  const localization = createLocalizationService();
  localization.register(createLocalizationProvider(fake));
  fake.localization = localization;
  const queryParams = requirePackageFile<(strapi: unknown) => unknown>(
    coreDir,
    "dist/services/query-params.js",
  )(fake);
  fake.get = (name: string) => {
    if (name === "query-params") return queryParams;
    if (name === "localization") return localization;
    throw new Error(`strapi.get(${name}) not stubbed`);
  };
  vi.stubGlobal("strapi", fake);
  const { createDocumentService } = requirePackageFile<{
    createDocumentService(strapi: unknown): TestDocumentService;
  }>(coreDir, "dist/services/document-service/index.js");
  const service = createDocumentService(fake);
  fake.documents = service;
  return {
    strapi: fake as TestStrapiInstance,
    service,
    db,
    engine,
    async close() {
      await settle(db);
      await engine.close();
    },
  };
}

interface TarnPool {
  numUsed(): number;
  numPendingAcquires(): number;
  numPendingCreates(): number;
}

/**
 * Waits (up to 2 s) until no query holds or waits for a connection. The
 * document service emits its entry events AFTER the commit, each with a
 * read of its own (document-service/events.js emitEvent), so a test can
 * end while one is still on its way; destroying the pool then would abort
 * it as an unhandled rejection.
 */
export async function settle(db: QueryEngine): Promise<void> {
  const pool = (db.connection as unknown as { client?: { pool?: TarnPool } }).client?.pool;
  if (!pool) return;
  const deadline = Date.now() + 2_000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const busy = pool.numUsed() + pool.numPendingAcquires() + pool.numPendingCreates();
    if (busy === 0 || Date.now() > deadline) return;
  }
}

/** Raw rows of a table (bypasses the query engine's attribute mapping). */
export async function tableRows(
  db: QueryEngine,
  table: string,
): Promise<Array<Record<string, unknown>>> {
  return (await db.connection.raw(`SELECT * FROM "${table}" ORDER BY id`)) as Array<
    Record<string, unknown>
  >;
}
