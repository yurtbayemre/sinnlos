/**
 * The wiki revision boot backfill (batch 16, lane 16D item 3; S26) against
 * Strapi's real query engine on a throwaway SQLite file
 * (src/test/sqlite-engine.test.helper.ts), with wiki-page and wiki-revision
 * models built by @strapi/core's own transform from the app's schemas (the
 * relations to other types left out): the raw reads run as written, on the
 * transaction. Pinned:
 *   - the anchor from one, none and several page documents;
 *   - kind NULL → before;
 *   - the baseline for a page without a snapshot, for a draft changed since
 *     the latest snapshot, for a published state no snapshot holds while
 *     the draft matches an older one, and none for a page in sync;
 *   - idempotent, and an error rolls everything back and throws.
 * The same code on Postgres 16 and through the real boot is pinned by
 * integration/authoring-wiki-revisions.integration.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openSqliteEngine,
  requirePackageFile,
  strapiPackageDir,
  type QueryEngine,
  type SqliteEngine,
} from "../test/sqlite-engine.test.helper";
import {
  REVISION_BACKFILL_LOG,
  backfillRevisions,
  type RevisionBackfillHost,
} from "./revision-backfill";

const PAGE = "api::wiki-page.wiki-page";
const REVISION = "api::wiki-revision.wiki-revision";

const timestamps = {
  createdAt: { type: "datetime" },
  updatedAt: { type: "datetime" },
  publishedAt: { type: "datetime", configurable: false, writable: true, visible: false },
  locale: { type: "string" },
};

const PAGE_TYPE = {
  uid: PAGE,
  modelType: "contentType",
  kind: "collectionType",
  modelName: "wiki-page",
  globalId: "WikiPage",
  collectionName: "wiki_pages",
  info: { singularName: "wiki-page", pluralName: "wiki-pages", displayName: "Wiki Page" },
  options: { draftAndPublish: true },
  attributes: {
    title: { type: "string" },
    body: { type: "richtext" },
    summary: { type: "text" },
    revisions: { type: "relation", relation: "oneToMany", target: REVISION, mappedBy: "page" },
    ...timestamps,
  },
};

/** The app's wiki-revision schema, without its link to users. */
function revisionType() {
  const schema = JSON.parse(
    readFileSync(
      join(
        __dirname,
        "..",
        "api",
        "wiki-revision",
        "content-types",
        "wiki-revision",
        "schema.json",
      ),
      "utf8",
    ),
  ) as { collectionName: string; info: object; options: object; attributes: object };
  const { editor: _editor, ...attributes } = schema.attributes as Record<string, unknown>;
  return {
    uid: REVISION,
    modelType: "contentType",
    kind: "collectionType",
    modelName: "wiki-revision",
    globalId: "WikiRevision",
    collectionName: schema.collectionName,
    info: schema.info,
    options: schema.options,
    attributes: { ...attributes, ...timestamps },
  };
}

let engine: SqliteEngine | undefined;

afterEach(async () => {
  await engine?.close();
  engine = undefined;
  vi.restoreAllMocks();
});

interface Fixture {
  db: QueryEngine;
  host: RevisionBackfillHost;
  logs: string[];
  page(documentId: string, data: Record<string, unknown>, published?: boolean): Promise<number>;
  revision(data: Record<string, unknown>, links?: number[]): Promise<number>;
  revisions(): Promise<Record<string, unknown>[]>;
}

async function fixture(): Promise<Fixture> {
  const { transformContentTypesToModels } = requirePackageFile<{
    transformContentTypesToModels(contentTypes: unknown[], identifiers: unknown): unknown[];
  }>(strapiPackageDir("@strapi/core"), "dist/utils/transform-content-types-to-models.js");
  engine = await openSqliteEngine((identifiers) =>
    transformContentTypesToModels([PAGE_TYPE, revisionType()], identifiers),
  );
  const { db } = engine;
  const logs: string[] = [];
  const host = { db, log: { info: (message: string) => logs.push(message) } };
  interface JoinTable {
    name: string;
    joinColumn: { name: string };
    inverseJoinColumn: { name: string };
  }
  const meta = (
    db as unknown as {
      metadata: { get(uid: string): { attributes: { page: { joinTable: JoinTable } } } };
    }
  ).metadata.get(REVISION);
  const join = meta.attributes.page.joinTable;
  const knex = db.connection as unknown as (table: string) => {
    insert(row: Record<string, unknown>): Promise<unknown>;
  };
  return {
    db,
    host: host as unknown as RevisionBackfillHost,
    logs,
    async page(documentId, data, published = false) {
      const row = await db.query(PAGE).create({
        data: { documentId, ...data, publishedAt: published ? new Date() : null },
      });
      return row.id as number;
    },
    async revision(data, links = []) {
      const row = await db.query(REVISION).create({
        data: { publishedAt: new Date(), ...data },
      });
      for (const pageId of links) {
        await knex(join.name).insert({
          [join.joinColumn.name]: row.id,
          [join.inverseJoinColumn.name]: pageId,
        });
      }
      return row.id as number;
    },
    revisions: () =>
      db.query(REVISION).findMany({
        select: ["id", "pageDocumentId", "kind", "title", "body", "pageSummary", "publishedAt"],
        populate: { page: { select: ["id"] } },
        orderBy: { id: "asc" },
      }),
  };
}

const content = (title: string, body: string, summary: string | null = null) => ({
  title,
  body,
  summary,
});
const snapshot = (pageDocumentId: string, title: string, body: string, kind = "after") => ({
  pageDocumentId,
  title,
  body,
  pageSummary: null,
  kind,
});

describe("backfillRevisions: anchors and kinds", () => {
  it("anchors a revision whose links name one page document, never none or several", async () => {
    const f = await fixture();
    const aDraft = await f.page("pageaaaaaaaaaaaaaaaaaaaa", content("A", "a"));
    const aPublished = await f.page("pageaaaaaaaaaaaaaaaaaaaa", content("A", "a"), true);
    const b = await f.page("pagebbbbbbbbbbbbbbbbbbbb", content("B", "b"));
    // S5.7: a revision gains a link to the published page row at publish.
    const one = await f.revision({ body: "old a" }, [aDraft, aPublished]);
    const none = await f.revision({ body: "orphan" });
    const several = await f.revision({ body: "damaged" }, [aDraft, b]);
    const anchored = await f.revision(
      { body: "kept", pageDocumentId: "pagebbbbbbbbbbbbbbbbbbbb" },
      [aDraft],
    );

    const counts = await backfillRevisions(f.host);
    const rows = new Map((await f.revisions()).map((row) => [row.id, row]));
    expect(rows.get(one)?.pageDocumentId).toBe("pageaaaaaaaaaaaaaaaaaaaa");
    expect(rows.get(none)?.pageDocumentId).toBeNull();
    expect(rows.get(several)?.pageDocumentId).toBeNull();
    // An anchor is never changed.
    expect(rows.get(anchored)?.pageDocumentId).toBe("pagebbbbbbbbbbbbbbbbbbbb");
    expect(counts).toMatchObject({ anchored: 1, kinds: 4, unanchored: 2 });
  });

  it("marks every row without a kind as a legacy before-image, and leaves the others", async () => {
    const f = await fixture();
    const legacy = await f.revision({ body: "legacy" });
    const after = await f.revision({ body: "after", kind: "after", pageDocumentId: "x" });
    const counts = await backfillRevisions(f.host);
    const kinds = new Map((await f.revisions()).map((row) => [row.id, row.kind]));
    expect([kinds.get(legacy), kinds.get(after)]).toEqual(["before", "after"]);
    expect(counts.kinds).toBe(1);
  });
});

describe("backfillRevisions: the cutover baseline", () => {
  const DOC = "pagecccccccccccccccccccc";

  it("records one baseline for a page without a snapshot, linked to its draft row", async () => {
    const f = await fixture();
    const draft = await f.page(DOC, content("C", "current", "sum"));
    await f.page(DOC, content("C", "current", "sum"), true);
    // A legacy before-image is no snapshot of the current content.
    await f.revision({ body: "current" }, [draft]);
    const counts = await backfillRevisions(f.host);
    const baselines = (await f.revisions()).filter((row) => row.kind === "baseline");
    expect(baselines).toEqual([
      expect.objectContaining({
        pageDocumentId: DOC,
        title: "C",
        body: "current",
        pageSummary: "sum",
        page: { id: draft },
        publishedAt: expect.anything(),
      }),
    ]);
    expect(counts.baselines).toBe(1);
  });

  it("records the draft when it changed since the latest snapshot", async () => {
    const f = await fixture();
    await f.page(DOC, content("C", "edited on 15.1"));
    await f.page(DOC, content("C", "published"), true);
    await f.revision(snapshot(DOC, "C", "published"));
    await backfillRevisions(f.host);
    const baselines = (await f.revisions()).filter((row) => row.kind === "baseline");
    expect(baselines.map((row) => row.body)).toEqual(["edited on 15.1"]);
  });

  it("records a published state no snapshot holds while the draft matches an older one (Codex round 2)", async () => {
    const f = await fixture();
    await f.page(DOC, content("C", "older"));
    await f.page(DOC, content("C", "published on 15.1"), true);
    await f.revision(snapshot(DOC, "C", "older"));
    await f.revision(snapshot(DOC, "C", "newest"));
    await backfillRevisions(f.host);
    const baselines = (await f.revisions()).filter((row) => row.kind === "baseline");
    expect(baselines.map((row) => row.body)).toEqual(["published on 15.1"]);
  });

  it("records both when both differ, the published state first (the newest is the draft)", async () => {
    const f = await fixture();
    const draft = await f.page(DOC, content("Draft", "draft"));
    await f.page(DOC, content("Live", "live"), true);
    await backfillRevisions(f.host);
    const baselines = (await f.revisions()).filter((row) => row.kind === "baseline");
    expect(baselines.map((row) => [row.title, (row.page as { id: number }).id])).toEqual([
      ["Live", draft],
      ["Draft", draft],
    ]);
  });

  it("links a published-only page's baseline to its published row", async () => {
    const f = await fixture();
    const published = await f.page(DOC, content("C", "only published"), true);
    await backfillRevisions(f.host);
    const [baseline] = (await f.revisions()).filter((row) => row.kind === "baseline");
    expect(baseline.page).toEqual({ id: published });
  });

  it("records nothing for a page in sync; empty and missing compare equal", async () => {
    const f = await fixture();
    await f.page(DOC, { title: "C", body: "same", summary: "" });
    await f.page(DOC, { title: "C", body: "same", summary: null }, true);
    await f.revision({ ...snapshot(DOC, "C", "same", "baseline"), pageSummary: null });
    const counts = await backfillRevisions(f.host);
    expect(counts.baselines).toBe(0);
  });

  it("is idempotent: a second run changes nothing and logs nothing", async () => {
    const f = await fixture();
    const draft = await f.page(DOC, content("Draft", "draft"));
    await f.page(DOC, content("Live", "live"), true);
    await f.revision({ body: "legacy" }, [draft]);
    const first = await backfillRevisions(f.host);
    expect(first).toEqual({ anchored: 1, kinds: 1, baselines: 2, unanchored: 0 });
    expect(f.logs).toEqual([
      `${REVISION_BACKFILL_LOG} anchored 1 revision(s) to their page, marked 1 legacy revision(s) ` +
        "'before', wrote 2 baseline(s); 0 revision(s) have no page anchor (page deleted, or linked " +
        "to several pages)",
    ]);
    const before = await f.revisions();
    expect(await backfillRevisions(f.host)).toEqual({
      anchored: 0,
      kinds: 0,
      baselines: 0,
      unanchored: 0,
    });
    expect(await f.revisions()).toEqual(before);
    expect(f.logs).toHaveLength(1);
  });

  it("an error rolls everything back and throws a [revision-backfill] error", async () => {
    const f = await fixture();
    const draft = await f.page(DOC, content("Draft", "draft"));
    await f.page(DOC, content("Live", "live"), true);
    const legacy = await f.revision({ body: "legacy" }, [draft]);
    const query = f.db.query.bind(f.db);
    let creates = 0;
    f.db.query = ((uid: string) => {
      const q = query(uid);
      if (uid !== REVISION) return q;
      return {
        ...q,
        updateMany: (params: Record<string, unknown>) =>
          (q as unknown as { updateMany(p: unknown): Promise<unknown> }).updateMany(params),
        count: (params: Record<string, unknown>) => q.count(params),
        create: async (params: { data: Record<string, unknown> }) => {
          creates += 1;
          if (creates === 2) throw new Error("insert failed");
          return q.create(params);
        },
      };
    }) as typeof f.db.query;
    await expect(backfillRevisions(f.host)).rejects.toThrow(
      /^\[revision-backfill\] could not backfill the wiki revisions \(insert failed\); nothing was changed/,
    );
    const rows = await f.revisions();
    expect(rows).toEqual([
      expect.objectContaining({ id: legacy, kind: null, pageDocumentId: null }),
    ]);
  });
});
