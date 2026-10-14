import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PG_URL } from "../database/pg-test-db.test.helper";
import { requireCmsDependency } from "../database/strapi-knex.test.helper";
import { ADMIN_ENV, contentManager } from "./admin-api.test.helper";
import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";
import { holdTransaction, qualified, settle, type Settled } from "./pg-lock.test.helper";
import {
  WIKI_PAGE,
  WIKI_SPACE,
  linkParentRaw,
  rowsOf,
  seedPage,
  seedSpace,
  wikiApi,
} from "./wiki.test.helper";

interface PgResult {
  command: string;
  rows: Array<Record<string, unknown>>;
}
interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<PgResult | PgResult[]>;
  end(): Promise<void>;
}

/**
 * The wiki checks (batch 16 plan S2, S15, §5 R10; lane 16B item 5) on
 * SQLite and Postgres 16, for every writer:
 *   - a parent loop is refused with `parentCycle` from the Document
 *     Service and the Content Manager (a `connect` payload, across spaces
 *     too); a diamond and a publish that keeps the graph pass;
 *   - on Postgres, with the structure row held by a second transaction so
 *     the writers queue on it: two parent changes that would close a loop
 *     (one is refused), a space delete against a page create in it (one
 *     fails, nothing dangles), Codex's interleaving (a discard, an
 *     unpublish and a draft save: no loop is ever committed), and the
 *     department-delete interleaving of §5 R10 (exactly one transaction is
 *     aborted with 40P01, nothing half-written remains); and the read-only
 *     infra/diagnostics/wiki-parent-cycles.sql lists the seeded loop, the
 *     page across spaces and the page without a space.
 * The content API's own refusals (author and moderator) are in
 * authoring-wiki-drafts.integration.test.ts.
 */

const DEPARTMENT = "api::department.department";
const LOCK_UID = "sinnlos::wiki-structure";

/** Whether the document-level parent graph holds a loop (every row's link). */
async function hasLoop(t: TestStrapi): Promise<boolean> {
  const rows = (await t.strapi.db.query(WIKI_PAGE).findMany({
    select: ["documentId"],
    populate: { parent: { select: ["documentId"] } },
  })) as Row[];
  const parents = new Map<string, Set<string>>();
  for (const row of rows) {
    const parent = (row.parent as { documentId?: string } | null)?.documentId;
    if (!parent) continue;
    const set = parents.get(row.documentId as string) ?? new Set<string>();
    set.add(parent);
    parents.set(row.documentId as string, set);
  }
  for (const start of parents.keys()) {
    const seen = new Set<string>();
    const stack = [...(parents.get(start) ?? [])];
    while (stack.length > 0) {
      const node = stack.pop() as string;
      if (node === start) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      stack.push(...(parents.get(node) ?? []));
    }
  }
  return false;
}

/** The error of a failed outcome (undefined for a success). */
const errorOf = (outcome: Settled<unknown>): unknown =>
  outcome.ok ? undefined : (outcome as { error: unknown }).error;

const isCycleRefusal = (outcome: Settled<unknown>): boolean =>
  (errorOf(outcome) as { details?: { codes?: Record<string, string> } } | undefined)?.details?.codes
    ?.parent === "parentCycle";

describe.each(testEngines())("wiki checks on %s", (engine) => {
  let t: TestStrapi;
  let space: Row & { documentId: string };
  let other: Row & { documentId: string };
  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: ADMIN_ENV });
    space = await seedSpace(t, { name: "IT Checks Space" });
    other = await seedSpace(t, { name: "IT Checks Other" });
  });
  afterAll(async () => {
    await t?.stop();
  });

  const docs = () => t.strapi.documents(WIKI_PAGE);

  it("refuses a loop from the Document Service, rolls the write back, and lets a diamond through", async () => {
    const a = await seedPage(t, { space: space.documentId });
    const b = await seedPage(t, { space: space.documentId, parent: a.documentId });
    const c = await seedPage(t, { space: space.documentId, parent: b.documentId });
    await expect(
      docs().update({ documentId: a.documentId, data: { parent: c.documentId } }),
    ).rejects.toMatchObject({ details: { keys: ["parent"], codes: { parent: "parentCycle" } } });
    expect(await hasLoop(t)).toBe(false);
    // A self-parent too, published in one step.
    await expect(
      docs().update({
        documentId: b.documentId,
        data: { parent: b.documentId },
        status: "published",
      }),
    ).rejects.toMatchObject({ details: { codes: { parent: "parentCycle" } } });
    // A diamond: c's draft under a while its published row stays under b.
    await docs().update({ documentId: c.documentId, data: { parent: a.documentId } });
    const publishedC = (await rowsOf(t, WIKI_PAGE, c.documentId)).find((row) => row.publishedAt);
    expect((publishedC?.parent as { documentId: string }).documentId).toBe(b.documentId);
    await expect(docs().publish({ documentId: c.documentId })).resolves.toBeDefined();
  });

  it("refuses a loop from the admin panel's connect payload, across spaces too", async () => {
    const panel = await contentManager(t);
    const x = await seedPage(t, { space: space.documentId });
    // The panel can place a parent in another space (FX07 note (c)).
    const y = await seedPage(t, { space: other.documentId, parent: x.documentId });
    const res = await panel.update(WIKI_PAGE, x.documentId, {
      parent: { connect: [{ documentId: y.documentId }], disconnect: [] },
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain("below itself");
    expect(await hasLoop(t)).toBe(false);
    // An unrelated panel save goes through.
    const ok = await panel.update(WIKI_PAGE, y.documentId, { title: "IT panel title" });
    expect(ok.status, ok.text).toBe(200);
  });

  it("refuses the draft save whose new parent would close a loop with the published graph", async () => {
    const top = await seedPage(t, { space: space.documentId });
    const mid = await seedPage(t, { space: space.documentId, parent: top.documentId });
    // The draft of top points at mid only on publish: the save of the draft
    // already adds the edge top -> mid, refused there.
    await expect(
      docs().update({ documentId: top.documentId, data: { parent: mid.documentId } }),
    ).rejects.toMatchObject({ details: { codes: { parent: "parentCycle" } } });
    expect(await hasLoop(t)).toBe(false);
  });

  it("refuses the slugs the web's routes use as words, from the Document Service and the panel", async () => {
    await expect(
      docs().create({ data: { title: "New", slug: "new", space: space.documentId } }),
    ).rejects.toMatchObject({ details: { keys: ["slug"] } });
    const panel = await contentManager(t);
    const page = await seedPage(t, { space: space.documentId });
    const res = await panel.update(WIKI_PAGE, page.documentId, { slug: "new" });
    expect(res.status).toBe(400);
    const target = await seedSpace(t);
    await expect(
      t.strapi.documents(WIKI_SPACE).update({
        documentId: target.documentId,
        data: { slug: "drafts" },
      }),
    ).rejects.toMatchObject({ details: { keys: ["slug"] } });
    // The other type's word is an ordinary slug.
    const renamed = await panel.update(WIKI_SPACE, target.documentId, {
      slug: `new-${Date.now()}`,
    });
    expect(renamed.status, renamed.text).toBe(200);
  });

  // ---- Postgres: writers queued on the held structure row -------------------

  describe.runIf(engine === "postgres")("races on the structure lock (Postgres)", () => {
    /** Holds the structure row in a second transaction. */
    async function holdStructure() {
      // The row exists after the first wiki write of the suite (lockDocument ensures it).
      const held = await holdTransaction(t);
      await held.raw(
        `SELECT id FROM ${qualified(t, "content_versions")} WHERE target_uid = ? AND target_document_id = ? FOR UPDATE`,
        [LOCK_UID, "global"],
      );
      return held;
    }

    /** Resolves once at least `count` statements of this schema wait for a lock. */
    async function lockWaits(count: number) {
      const schema = t.database.env.DATABASE_SCHEMA as string;
      await expect
        .poll(
          async () => {
            const [row] = await t.database.sql<{ n: number | string }>(
              "SELECT count(*) AS n FROM pg_stat_activity " +
                "WHERE wait_event_type = 'Lock' AND position(? in query) > 0",
              [schema],
            );
            return Number(row?.n ?? 0);
          },
          { timeout: 15_000, interval: 50 },
        )
        .toBeGreaterThanOrEqual(count);
    }

    it("a page create queued behind its space's delete answers invalid on space, from the content API too", async () => {
      for (const source of ["content API", "Document Service"] as const) {
        const target = await seedSpace(t);
        const title = `IT Queued Page ${source}`;
        const held = await holdStructure();
        // The delete queues first on the structure row, so it wins.
        const removal = settle(
          t.strapi.documents(WIKI_SPACE).delete({ documentId: target.documentId }),
        );
        await lockWaits(1);
        const creation =
          source === "content API"
            ? wikiApi(t).createDraft("editor", { title, body: "x", space: target.documentId })
            : settle(
                docs().create({
                  data: { title, slug: `it-q-${Date.now()}`, space: target.documentId },
                }),
              );
        await lockWaits(2);
        await held.commit();
        expect((await removal).ok, source).toBe(true);
        const created = await creation;
        if (source === "content API") {
          const res = created as Awaited<ReturnType<ReturnType<typeof wikiApi>["createDraft"]>>;
          expect(res.status, res.text).toBe(400);
          expect((res.body as { error?: { details?: unknown } }).error?.details).toMatchObject({
            keys: ["space"],
          });
        } else {
          expect(errorOf(created as Settled<unknown>)).toMatchObject({
            details: { keys: ["space"] },
          });
        }
        expect(await t.strapi.db.query(WIKI_PAGE).count({ where: { title } })).toBe(0);
      }
    });

    it("two parent changes that would close a loop between them: one is refused", async () => {
      const a = await seedPage(t, { space: space.documentId });
      const b = await seedPage(t, { space: space.documentId });
      const held = await holdStructure();
      const first = settle(
        docs().update({ documentId: a.documentId, data: { parent: b.documentId } }),
      );
      await lockWaits(1);
      const second = settle(
        docs().update({ documentId: b.documentId, data: { parent: a.documentId } }),
      );
      await lockWaits(2);
      await held.commit();
      const outcomes = await Promise.all([first, second]);
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.filter(isCycleRefusal)).toHaveLength(1);
      expect(await hasLoop(t)).toBe(false);
    });

    it("a space delete against a page create in it: one fails, no page without its space", async () => {
      const target = await seedSpace(t);
      const held = await holdStructure();
      const removal = settle(
        t.strapi.documents(WIKI_SPACE).delete({ documentId: target.documentId }),
      );
      await lockWaits(1);
      const creation = settle(
        docs().create({
          data: {
            title: "IT Racing Page",
            slug: `it-racing-${Date.now()}`,
            space: target.documentId,
          },
          status: "published",
        }),
      );
      await lockWaits(2);
      await held.commit();
      const [removed, created] = await Promise.all([removal, creation]);
      expect([removed.ok, created.ok].filter(Boolean)).toHaveLength(1);
      const pages = (await t.strapi.db.query(WIKI_PAGE).findMany({
        where: { title: "IT Racing Page" },
        populate: { space: { select: ["id"] } },
      })) as Row[];
      if (removed.ok) {
        expect(pages).toEqual([]);
        expect(errorOf(created)).toMatchObject({ details: { keys: ["space"] } });
      } else {
        expect((errorOf(removed) as { details?: unknown }).details).toEqual({
          keys: ["_form"],
          codes: { _form: "spaceNotEmpty" },
        });
        expect(pages.length).toBeGreaterThan(0);
        for (const page of pages) expect(page.space).not.toBeNull();
      }
    });

    it("a space republish against a page publish in it: both commit, every page row keeps its space (Codex re-review)", async () => {
      // The republish re-creates the published space row from the page
      // links it loaded before deleting the old row; it queues on the
      // structure row, so no page publish commits inside that window.
      const target = await seedSpace(t);
      const held = await holdStructure();
      const republish = settle(
        t.strapi.documents(WIKI_SPACE).update({
          documentId: target.documentId,
          data: { description: "IT republished" },
          status: "published",
        }),
      );
      await lockWaits(1);
      const creation = settle(
        docs().create({
          data: {
            title: "IT Republish Page",
            slug: `it-republish-${Date.now()}`,
            space: target.documentId,
          },
          status: "published",
        }),
      );
      await lockWaits(2);
      await held.commit();
      const [republished, created] = await Promise.all([republish, creation]);
      expect(republished.ok, String(errorOf(republished))).toBe(true);
      expect(created.ok, String(errorOf(created))).toBe(true);
      const page = (created as { value: { documentId: string } }).value;
      const rows = await rowsOf(t, WIKI_PAGE, page.documentId);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect((row.space as { documentId?: string } | null)?.documentId).toBe(target.documentId);
      }
      // A second republish after the page is in keeps the link as well.
      await t.strapi.documents(WIKI_SPACE).publish({ documentId: target.documentId });
      for (const row of await rowsOf(t, WIKI_PAGE, page.documentId)) {
        expect((row.space as { documentId?: string } | null)?.documentId).toBe(target.documentId);
      }
    });

    it("Codex's interleaving: a discard, an unpublish and a draft save never commit a loop", async () => {
      // A -> D on both rows; B published under A, its draft without a parent.
      const d = await seedPage(t, { space: space.documentId });
      const a = await seedPage(t, { space: space.documentId, parent: d.documentId });
      const b = await seedPage(t, { space: space.documentId, parent: a.documentId });
      await docs().update({ documentId: b.documentId, data: { parent: null } });
      await docs().update({ documentId: a.documentId, data: { title: "IT A changed" } });
      const held = await holdStructure();
      const discard = settle(docs().discardDraft({ documentId: a.documentId }));
      await lockWaits(1);
      const unpublish = settle(docs().unpublish({ documentId: b.documentId }));
      await lockWaits(2);
      const save = settle(
        docs().update({ documentId: d.documentId, data: { parent: b.documentId } }),
      );
      await lockWaits(3);
      await held.commit();
      const outcomes = await Promise.all([discard, unpublish, save]);
      for (const outcome of outcomes) {
        if (!outcome.ok) {
          expect(isCycleRefusal(outcome), String(errorOf(outcome))).toBe(true);
        }
      }
      expect(await hasLoop(t)).toBe(false);
    });

    it("the department-delete interleaving (§5 R10): exactly one transaction aborts with 40P01, nothing half-written", async () => {
      const department = await t.strapi.documents(DEPARTMENT).create({
        data: { name: `IT Doomed ${Date.now()}`, slug: `it-doomed-${Date.now()}` },
      });
      // P1 links the department; P2 does not yet.
      const p1 = await seedPage(t, { space: space.documentId, department: department.documentId });
      const p2 = await seedPage(t, { space: space.documentId });
      const held = await holdStructure();
      // save2 queues first on the structure row, then save1 (holding P1's row).
      const save2 = settle(
        docs().update({
          documentId: p2.documentId,
          data: { department: department.documentId },
        }),
      );
      await lockWaits(1);
      const save1 = settle(
        docs().update({ documentId: p1.documentId, data: { title: "IT P1 v2" } }),
      );
      await lockWaits(2);
      // The delete locks the department rows, then waits for P1's version row.
      const removal = settle(
        t.strapi.documents(DEPARTMENT).delete({ documentId: department.documentId }),
      );
      await lockWaits(3);
      // Released: save2 takes the structure row and waits for the department row.
      await held.commit();
      const outcomes = await Promise.all([save2, save1, removal]);
      const deadlocks = outcomes.filter(
        (outcome) => !outcome.ok && (errorOf(outcome) as { code?: string }).code === "40P01",
      );
      expect(deadlocks).toHaveLength(1);
      // Nothing half-written: the department is gone with every link to it,
      // or it is there with the links its committed writers made.
      const left = await t.strapi.db
        .query(DEPARTMENT)
        .count({ where: { documentId: department.documentId } });
      const linked = (await t.strapi.db.query(WIKI_PAGE).findMany({
        where: { department: { documentId: department.documentId } },
        select: ["documentId"],
      })) as Row[];
      if (left === 0) expect(linked).toEqual([]);
      else expect(linked.map((row) => row.documentId)).toContain(p1.documentId);
      expect(await hasLoop(t)).toBe(false);
    });

    it("infra/diagnostics/wiki-parent-cycles.sql runs read-only and lists exactly the seeded rows", async () => {
      // A legacy loop (raw), a parent in another space, a page without a space.
      const loopA = await seedPage(t, { space: space.documentId });
      const loopB = await seedPage(t, { space: space.documentId, parent: loopA.documentId });
      const rowsA = await rowsOf(t, WIKI_PAGE, loopA.documentId);
      const rowsB = await rowsOf(t, WIKI_PAGE, loopB.documentId);
      for (const row of rowsA) {
        const twin = rowsB.find(
          (candidate) => (candidate.publishedAt == null) === (row.publishedAt == null),
        );
        await linkParentRaw(t, row.id, (twin as Row).id);
      }
      const across = await seedPage(t, { space: other.documentId, parent: loopA.documentId });
      const homeless = await seedPage(t, {});

      const { Client } = requireCmsDependency<{
        Client: new (config: { connectionString: string }) => PgClient;
      }>("pg");
      const client = new Client({ connectionString: PG_URL });
      await client.connect();
      try {
        await client.query(`SET search_path TO "${t.database.env.DATABASE_SCHEMA}"`);
        const results = await client.query(
          readFileSync(
            join(
              __dirname,
              "..",
              "..",
              "..",
              "..",
              "infra",
              "diagnostics",
              "wiki-parent-cycles.sql",
            ),
            "utf8",
          ),
        );
        const list = Array.isArray(results) ? results : [results];
        expect(list[0].command).toBe("BEGIN");
        expect(list[list.length - 1].command).toBe("ROLLBACK");
        const [loops, crossSpace, withoutSpace, [summary]] = list
          .filter((result) => result.command === "SELECT")
          .map((result) => result.rows);
        expect(loops.map((row) => row.document_id).sort()).toEqual(
          [loopA.documentId, loopB.documentId].sort(),
        );
        expect(String(loops[0].path)).toContain(" -> ");
        // The admin panel test above placed one more page across spaces.
        expect(
          crossSpace
            .filter((row) => row.document_id === across.documentId)
            .map((row) => row.status),
        ).toEqual(["draft", "published"]);
        expect(withoutSpace.map((row) => row.document_id)).toEqual([
          homeless.documentId,
          homeless.documentId,
        ]);
        expect(summary).toMatchObject({ check: "summary" });
        expect(Number(summary.pages_on_loops)).toBe(2);
        expect(Number(summary.rows_with_parent_in_other_space)).toBe(crossSpace.length);
        expect(Number(summary.pages_without_space)).toBe(1);
      } finally {
        await client.end();
      }
    });
  });
});
