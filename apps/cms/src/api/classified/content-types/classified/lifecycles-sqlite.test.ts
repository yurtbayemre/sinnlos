import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import lifecycles from "./lifecycles";

/**
 * FX45 regression against Strapi's real query engine (@strapi/database
 * 5.55.1 on better-sqlite3, the local-dev database; a temp file, because the
 * engine's SQLite dialect resolves the filename to a path).
 *
 * knex gives SQLite a pool of exactly one connection. The Document Service
 * deletes inside a transaction, and the classified beforeDelete scan used to
 * read the image ids from files_related_mph on the pool: it waited for the
 * connection its own transaction held until knex's acquireConnectionTimeout
 * (60 s in the app, 2 s here), failed open, and the ad's images stayed
 * behind. Now the scan joins the transaction: the delete is quick, and the
 * post-commit cleanup removes the images through the upload service.
 */

const CLASSIFIED = "api::classified.classified";
const FILE = "plugin::upload.file";
const ACQUIRE_TIMEOUT_MS = 2000;

interface QueryEngine {
  connection: { raw(sql: string): Promise<unknown> };
  init(options: { models: unknown[] }): Promise<unknown>;
  schema: { create(): Promise<void> };
  query(uid: string): {
    create(params: { data: Record<string, unknown> }): Promise<{ id: number }>;
    delete(params: { where: Record<string, unknown> }): Promise<unknown>;
    findOne(params: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
    findMany(params: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  };
  transaction<T>(cb: () => Promise<T>): Promise<T>;
  getConnection(table: string): unknown;
  destroy(): Promise<void>;
}

/**
 * The two models as Strapi's content-type loader hands them to the engine: a
 * media field is a morphMany into the upload file's morphToMany `related`,
 * stored in files_related_mph (@strapi/core transformAttribute).
 */
const MODELS = [
  {
    uid: FILE,
    singularName: "file",
    tableName: "files",
    attributes: {
      id: { type: "increments" },
      documentId: { type: "string" },
      name: { type: "string" },
      provider: { type: "string" },
      provider_metadata: { type: "json" },
      related: { type: "relation", relation: "morphToMany" },
    },
  },
  {
    uid: CLASSIFIED,
    singularName: "classified",
    tableName: "classifieds",
    attributes: {
      id: { type: "increments" },
      documentId: { type: "string" },
      title: { type: "string" },
      images: { type: "relation", relation: "morphMany", target: FILE, morphBy: "related" },
    },
    lifecycles,
  },
];

const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function loadDatabase(): new (config: Record<string, unknown>) => QueryEngine {
  const requireFromCms = createRequire(
    join(__dirname, "..", "..", "..", "..", "..", "package.json"),
  );
  const requireFromStrapi = createRequire(requireFromCms.resolve("@strapi/strapi/package.json"));
  return (
    requireFromStrapi("@strapi/database") as {
      Database: new (config: Record<string, unknown>) => QueryEngine;
    }
  ).Database;
}

let db: QueryEngine | undefined;
let tempDir: string;
let restoreStrapi: unknown;
const removed: number[] = [];
const errors: string[] = [];

function engine(): QueryEngine {
  if (!db) throw new Error("no query engine");
  return db;
}

// The first hook loads @strapi/database and the SQLite driver cold, which
// can pass the 10 s hook default under a full parallel run (§5.40).
beforeEach(async () => {
  const Database = loadDatabase();
  tempDir = mkdtempSync(join(tmpdir(), "sinnlos-classified-delete-"));
  db = new Database({
    connection: {
      client: "sqlite",
      connection: { filename: join(tempDir, "cms.db") },
      useNullAsDefault: true,
      acquireConnectionTimeout: ACQUIRE_TIMEOUT_MS,
    },
    settings: { migrations: { dir: join(tempDir, "migrations") }, forceMigration: false },
    logger: quiet,
  });
  await db.init({ models: MODELS });
  await db.schema.create();

  removed.length = 0;
  errors.length = 0;
  restoreStrapi = (globalThis as { strapi?: unknown }).strapi;
  const engineRef = db;
  (globalThis as { strapi?: unknown }).strapi = {
    db: engineRef,
    log: {
      info: () => undefined,
      error: (message: string) => {
        errors.push(message);
      },
    },
    // The upload service's remove() deletes the file row (and the bytes).
    plugin: () => ({
      service: () => ({
        remove: async (file: { id: number }) => {
          await engineRef.query(FILE).delete({ where: { id: file.id } });
          removed.push(file.id);
        },
      }),
    }),
  };
}, 30_000);

afterEach(async () => {
  (globalThis as { strapi?: unknown }).strapi = restoreStrapi;
  await db?.destroy();
  db = undefined;
  rmSync(tempDir, { recursive: true, force: true });
});

async function uploadImage(name: string, uploadedBy: number | null): Promise<number> {
  const file = await engine()
    .query(FILE)
    .create({
      data: {
        name,
        provider: "local",
        provider_metadata: uploadedBy === null ? null : { uploadedBy },
      },
    });
  return file.id;
}

describe("classified delete on SQLite (FX45)", () => {
  it("finishes quickly inside a transaction and removes the ad's stamped images", async () => {
    const photo = await uploadImage("photo.png", 7);
    const second = await uploadImage("second.png", 7);
    const adminUpload = await uploadImage("logo.png", null);
    const shared = await uploadImage("shared.png", 7);
    const ad = await engine()
      .query(CLASSIFIED)
      .create({ data: { title: "Bike", images: [photo, second, adminUpload, shared] } });
    await engine()
      .query(CLASSIFIED)
      .create({ data: { title: "Helmet", images: [shared] } });

    const started = Date.now();
    // The Document Service wraps every delete in a transaction.
    await engine().transaction(() =>
      engine()
        .query(CLASSIFIED)
        .delete({ where: { id: ad.id } }),
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(ACQUIRE_TIMEOUT_MS / 2);
    expect(errors).toEqual([]);
    // The cleanup runs after the commit, asynchronously.
    await vi.waitFor(() => expect(removed.sort()).toEqual([photo, second].sort()), {
      timeout: 5000,
    });
    const left = (
      await engine()
        .query(FILE)
        .findMany({ select: ["id"] })
    ).map((f) => f.id);
    // The admin upload is never touched; the image of the other ad stays.
    expect(left.sort()).toEqual([adminUpload, shared].sort());
  });

  it("still works without an ambient transaction", async () => {
    const photo = await uploadImage("photo.png", 7);
    const ad = await engine()
      .query(CLASSIFIED)
      .create({ data: { title: "Desk", images: [photo] } });
    await engine()
      .query(CLASSIFIED)
      .delete({ where: { id: ad.id } });
    await vi.waitFor(() => expect(removed).toEqual([photo]), { timeout: 5000 });
    expect(errors).toEqual([]);
  });
});
