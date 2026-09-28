import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";

/**
 * FX38 seed assertion: the demo seed (SEED_DEMO_DATA=1, run by the real
 * bootstrap) writes every draft & publish document through the Document
 * Service, so each has exactly ONE draft row and ONE published row, with
 * the same relations on both (a draft links the target's draft, the
 * published row the target's published row). department and team have no
 * draft & publish since decision 05: one row per document, published.
 *
 * utils/draft-twins.ts runs right after the seed in bootstrap and gives a
 * published-only document its draft, so "one draft + one published row"
 * alone would stay green for a seed that writes published-only rows again
 * (the pre-FX38 state). What is asserted: the draft of every seeded
 * document predates its published row (lower id), so the seed wrote the
 * pair itself and draft-twins had nothing to repair.
 */

/** The seeded draft & publish types and how many documents the seed writes. */
const SEEDED_DOCUMENTS: ReadonlyArray<readonly [uid: string, count: number]> = [
  ["api::announcement.announcement", 5],
  ["api::event.event", 6],
  ["api::wiki-space.wiki-space", 3],
  ["api::wiki-page.wiki-page", 5],
  ["api::poll.poll", 3],
  ["api::document.document", 6],
];

const SEEDED_DEPARTMENTS = ["Engineering", "Design", "Marketing", "Human Resources", "Finance"];

type RelationRow = { documentId?: string; publishedAt?: unknown } | null | undefined;

const isPublished = (row: Row) => row.publishedAt != null;

function byDocument(rows: readonly Row[]): Map<string, Row[]> {
  const map = new Map<string, Row[]>();
  for (const row of rows) map.set(row.documentId, [...(map.get(row.documentId) ?? []), row]);
  return map;
}

describe.each(testEngines())("demo seed on %s (FX38)", (engine) => {
  let t: TestStrapi;

  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: { SEED_DEMO_DATA: "1" } });
  });

  afterAll(async () => {
    await t?.stop();
  });

  it.each(SEEDED_DOCUMENTS)(
    "%s: one draft and one published row per document",
    async (uid, count) => {
      const rows = await t.strapi.db
        .query(uid)
        .findMany({ select: ["id", "documentId", "publishedAt"] });
      const documents = byDocument(rows);
      expect(documents.size).toBe(count);
      for (const [documentId, pair] of documents) {
        expect({ documentId, rows: pair.length }).toEqual({ documentId, rows: 2 });
        expect(pair.filter(isPublished)).toHaveLength(1);
        // Two rows, two different ids (publish is delete + recreate).
        expect(new Set(pair.map((row) => row.id)).size).toBe(2);
        // The Document Service writes the draft and then publishes it
        // (@strapi/core document-service/repository.js create → publish),
        // so a seeded draft has the lower id. A draft-twins clone is
        // inserted AFTER the published row: a higher draft id means the
        // seed wrote a published-only row and the boot repair covered it.
        const draft = pair.find((row) => !isPublished(row));
        const published = pair.find(isPublished);
        const draftFirst =
          draft !== undefined && published !== undefined && draft.id < published.id;
        expect({ documentId, draftFirst }).toEqual({ documentId, draftFirst: true });
      }
    },
  );

  it("wiki pages: the draft links the space's draft, the published row the published space", async () => {
    const pages = await t.strapi.db.query("api::wiki-page.wiki-page").findMany({
      select: ["id", "documentId", "publishedAt"],
      populate: { space: { select: ["documentId", "publishedAt"] }, author: { select: ["id"] } },
    });
    expect(pages).toHaveLength(10);
    for (const [, pair] of byDocument(pages)) {
      const draft = pair.find((row) => !isPublished(row));
      const published = pair.find(isPublished);
      const draftSpace = draft?.space as RelationRow;
      const publishedSpace = published?.space as RelationRow;
      expect(draftSpace?.documentId).toBeTruthy();
      expect(publishedSpace?.documentId).toBe(draftSpace?.documentId);
      expect(draftSpace?.publishedAt ?? null).toBeNull();
      expect(publishedSpace?.publishedAt).not.toBeNull();
      // Non-D&P relation (users): the same row on both copies.
      expect((draft?.author as { id?: number } | null)?.id).toBeTypeOf("number");
      expect((published?.author as { id?: number } | null)?.id).toBe(
        (draft?.author as { id?: number }).id,
      );
    }
  });

  it("department and team: one published row per document (decision 05)", async () => {
    for (const uid of ["api::department.department", "api::team.team"]) {
      const rows = await t.strapi.db
        .query(uid)
        .findMany({ select: ["id", "documentId", "publishedAt"] });
      for (const [documentId, copies] of byDocument(rows)) {
        expect({ uid, documentId, rows: copies.length }).toEqual({ uid, documentId, rows: 1 });
        expect(isPublished(copies[0])).toBe(true);
      }
    }
    const departments = await t.strapi.db
      .query("api::department.department")
      .findMany({ select: ["name"], where: { name: { $in: SEEDED_DEPARTMENTS } } });
    expect(departments.map((row) => row.name).sort()).toEqual([...SEEDED_DEPARTMENTS].sort());
    expect(
      await t.strapi.db.query("api::team.team").count({ where: { slug: { $ne: "it-platform" } } }),
    ).toBe(8);
  });

  it("the seeded accounts sign in and read the seeded content over HTTP", async () => {
    const jwt = await t.login("casey.jones", "demo1234");
    const pages = await t.api<{ data: { title: string }[] }>(
      { jwt },
      "/api/wiki-pages?pagination[pageSize]=50",
    );
    expect(pages.status).toBe(200);
    expect(pages.body.data.map((page) => page.title)).toHaveLength(5);
    const announcements = await t.api<{ data: unknown[] }>({ jwt }, "/api/announcements");
    expect(announcements.status).toBe(200);
    expect(announcements.body.data.length).toBeGreaterThan(0);
  });
});
