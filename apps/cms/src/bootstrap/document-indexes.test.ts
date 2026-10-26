/**
 * The boot indexes of v2 authoring (bootstrap/document-indexes.ts): which
 * indexes, their DDL per engine, and what a boot creates and logs. The
 * indexes on a real database are pinned by the scheduler suite (S9.0) and
 * the wiki history suite (integration).
 */
import { describe, expect, it, vi } from "vitest";

import {
  CONTENT_VERSION_INDEX,
  documentIndexSpecs,
  ensureDocumentIndexes,
  indexSql,
  type DocumentIndexHost,
} from "./document-indexes";

const TABLES: Record<string, string> = {
  "api::content-version.content-version": "content_versions",
  "api::announcement.announcement": "announcements",
  "api::event.event": "events",
  "api::document.document": "documents",
  "api::quick-link.quick-link": "quick_links",
  "api::course.course": "courses",
  "api::lesson.lesson": "lessons",
  "api::wiki-page.wiki-page": "wiki_pages",
  "api::wiki-revision.wiki-revision": "wiki_revisions",
  "api::notification.notification": "notifications",
  "api::comment.comment": "comments",
  "api::reaction.reaction": "reactions",
  "api::acknowledgement.acknowledgement": "acknowledgements",
};

/** The polymorphic anchor indexes (v0.31, #171). */
const ANCHORS = [
  {
    name: "notifications_source_type_source_document_id_idx",
    table: "notifications",
    columns: ["source_type", "source_document_id"],
    unique: false,
  },
  {
    name: "comments_target_type_target_document_id_idx",
    table: "comments",
    columns: ["target_type", "target_document_id"],
    unique: false,
  },
  {
    name: "reactions_target_type_target_document_id_idx",
    table: "reactions",
    columns: ["target_type", "target_document_id"],
    unique: false,
  },
  {
    name: "acknowledgements_target_type_target_document_id_idx",
    table: "acknowledgements",
    columns: ["target_type", "target_document_id"],
    unique: false,
  },
];

/** The wiki revision anchor index (batch 16, DA03). */
const ANCHOR = {
  name: "wiki_revisions_page_document_id_idx",
  table: "wiki_revisions",
  columns: ["page_document_id"],
  unique: false,
};

function host(client: "postgres" | "sqlite", existing: string[] = []) {
  const raw = vi.fn(async (sql: string) => {
    if (!sql.includes("pg_indexes") && !sql.includes("sqlite_master")) return [];
    const rows = existing.map((name) => ({ name }));
    return client === "postgres" ? { rows } : rows;
  });
  const info = vi.fn();
  const strapi: DocumentIndexHost = {
    db: {
      connection: { raw },
      dialect: { client },
      getSchemaName: () => (client === "postgres" ? "public" : undefined),
      metadata: {
        get: (uid) => (TABLES[uid] ? { tableName: TABLES[uid], attributes: {} } : undefined),
      },
    },
    log: { info },
  };
  return { strapi, raw, info };
}

describe("documentIndexSpecs", () => {
  it("names the version index, the schedule indexes and the wiki revision anchor", () => {
    const specs = documentIndexSpecs(host("sqlite").strapi);
    expect(specs.map((spec) => spec.name)).toContain(CONTENT_VERSION_INDEX);
    expect(specs.find((spec) => spec.name === ANCHOR.name)).toEqual(ANCHOR);
  });

  it("names the notification, comment and reaction anchors (v0.31)", () => {
    const specs = documentIndexSpecs(host("sqlite").strapi);
    for (const anchor of ANCHORS) {
      expect(specs.find((spec) => spec.name === anchor.name)).toEqual(anchor);
    }
  });

  it("refuses when the wiki revision model is not loaded", () => {
    const { strapi } = host("sqlite");
    const get = strapi.db.metadata.get;
    strapi.db.metadata.get = (uid) =>
      uid === "api::wiki-revision.wiki-revision" ? undefined : get(uid);
    expect(() => documentIndexSpecs(strapi)).toThrow(
      "the model api::wiki-revision.wiki-revision is not loaded",
    );
  });
});

describe("indexSql", () => {
  it("is a plain IF NOT EXISTS index on both engines", () => {
    expect(indexSql("postgres", "public", ANCHOR)).toBe(
      'CREATE INDEX IF NOT EXISTS "wiki_revisions_page_document_id_idx" ON "public"."wiki_revisions" ("page_document_id")',
    );
    expect(indexSql("sqlite", "public", ANCHOR)).toBe(
      'CREATE INDEX IF NOT EXISTS "wiki_revisions_page_document_id_idx" ON "wiki_revisions" ("page_document_id")',
    );
  });
});

describe("ensureDocumentIndexes", () => {
  it("creates the missing anchor index on the first boot of batch 16 and logs it", async () => {
    const all = documentIndexSpecs(host("postgres").strapi).map((spec) => spec.name);
    const { strapi, raw, info } = host(
      "postgres",
      all.filter((name) => name !== ANCHOR.name),
    );
    expect(await ensureDocumentIndexes(strapi)).toEqual([ANCHOR.name]);
    expect(raw).toHaveBeenLastCalledWith(
      'CREATE INDEX IF NOT EXISTS "wiki_revisions_page_document_id_idx" ON "public"."wiki_revisions" ("page_document_id")',
    );
    expect(info).toHaveBeenCalledWith(
      "[document-indexes] created 1 index(es): wiki_revisions_page_document_id_idx",
    );
  });

  it("creates the four anchor indexes on the first boot of v0.31 and logs them once", async () => {
    const all = documentIndexSpecs(host("postgres").strapi).map((spec) => spec.name);
    const names = ANCHORS.map((anchor) => anchor.name);
    const { strapi, raw, info } = host(
      "postgres",
      all.filter((name) => !names.includes(name)),
    );
    expect(await ensureDocumentIndexes(strapi)).toEqual(names);
    expect(raw).toHaveBeenCalledWith(
      'CREATE INDEX IF NOT EXISTS "notifications_source_type_source_document_id_idx" ON "public"."notifications" ("source_type", "source_document_id")',
    );
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      `[document-indexes] created 4 index(es): ${names.join(", ")}`,
    );
  });

  it("creates nothing and logs nothing once every index exists", async () => {
    const all = documentIndexSpecs(host("sqlite").strapi).map((spec) => spec.name);
    const { strapi, raw, info } = host("sqlite", all);
    expect(await ensureDocumentIndexes(strapi)).toEqual([]);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });
});
