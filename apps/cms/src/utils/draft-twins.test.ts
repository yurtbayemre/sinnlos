/**
 * Draft-twin repair (utils/draft-twins.ts). The fake mirrors the calls the
 * repair makes on Strapi: `db.query(uid).findMany/count` with the exact
 * where shapes it sends, `db.transaction` (rolls the fake table back when the
 * callback throws) and `documents(uid).discardDraft`, which, like Strapi's,
 * clones every published row of the document (and locale) into a new draft
 * row and replaces an existing draft.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DRAFT_TWINS_SKIPPED_UIDS,
  ensureDraftTwins,
  findPublishedOnlyRows,
  planDraftTwinTypes,
  type DraftTwinModel,
  type DraftTwinRow,
  type DraftTwinsHost,
} from "./draft-twins";

const ANNOUNCEMENT = "api::announcement.announcement";
const LESSON = "api::lesson.lesson";
const COURSE = "api::course.course";
const REVISION = "api::wiki-revision.wiki-revision";

const dp = (attributes: DraftTwinModel["attributes"] = {}): DraftTwinModel => ({
  options: { draftAndPublish: true },
  attributes,
});

// --- planDraftTwinTypes ------------------------------------------------------

describe("planDraftTwinTypes", () => {
  it("takes the app's draft & publish types only, without wiki-revision", () => {
    const plan = planDraftTwinTypes({
      [ANNOUNCEMENT]: dp(),
      "api::department.department": { options: { draftAndPublish: false } },
      "api::kudos.kudos": { attributes: {} },
      [REVISION]: dp(),
      "plugin::some.thing": dp(),
      "admin::user": dp(),
    });
    expect(plan).toEqual({ order: [ANNOUNCEMENT], cyclic: [] });
    expect(DRAFT_TWINS_SKIPPED_UIDS).toEqual([REVISION]);
  });

  it("orders alphabetically when no unidirectional relation links two of them", () => {
    const plan = planDraftTwinTypes({
      "api::c.c": dp(),
      "api::a.a": dp(),
      "api::b.b": dp(),
    });
    expect(plan.order).toEqual(["api::a.a", "api::b.b", "api::c.c"]);
  });

  it("puts the target of a unidirectional relation before its source", () => {
    const plan = planDraftTwinTypes({
      "api::a.a": dp({ b: { type: "relation", relation: "manyToOne", target: "api::b.b" } }),
      "api::b.b": dp({ c: { type: "relation", relation: "manyToMany", target: "api::c.c" } }),
      "api::c.c": dp(),
      "api::d.d": dp(),
    });
    expect(plan).toEqual({
      order: ["api::c.c", "api::b.b", "api::a.a", "api::d.d"],
      cyclic: [],
    });
  });

  it("ignores bidirectional, self, media and non-candidate relations", () => {
    const plan = planDraftTwinTypes({
      [COURSE]: dp({
        lessons: { type: "relation", relation: "oneToMany", target: LESSON, mappedBy: "course" },
        coverImage: { type: "media" },
      }),
      [LESSON]: dp({
        course: { type: "relation", relation: "manyToOne", target: COURSE, inversedBy: "lessons" },
        parent: { type: "relation", relation: "manyToOne", target: LESSON },
        department: {
          type: "relation",
          relation: "manyToOne",
          target: "api::department.department",
        },
        revision: { type: "relation", relation: "manyToOne", target: REVISION },
        author: {
          type: "relation",
          relation: "oneToOne",
          target: "plugin::users-permissions.user",
        },
      }),
      "api::department.department": { options: { draftAndPublish: false } },
      [REVISION]: dp(),
    });
    expect(plan).toEqual({ order: [COURSE, LESSON], cyclic: [] });
  });

  it("appends the types of a unidirectional cycle alphabetically and names them", () => {
    const plan = planDraftTwinTypes({
      "api::x.x": dp({ y: { type: "relation", relation: "manyToOne", target: "api::y.y" } }),
      "api::y.y": dp({ x: { type: "relation", relation: "manyToOne", target: "api::x.x" } }),
      "api::z.z": dp({ x: { type: "relation", relation: "manyToOne", target: "api::x.x" } }),
      "api::a.a": dp(),
    });
    expect(plan).toEqual({
      order: ["api::a.a", "api::x.x", "api::y.y", "api::z.z"],
      cyclic: ["api::x.x", "api::y.y", "api::z.z"],
    });
  });

  it("plans the app's schemas: nine types, alphabetical, no ordering constraint today", () => {
    const apiDir = join(__dirname, "..", "api");
    const contentTypes: Record<string, DraftTwinModel> = {};
    for (const api of readdirSync(apiDir)) {
      const typesDir = join(apiDir, api, "content-types");
      if (!existsSync(typesDir)) continue;
      for (const name of readdirSync(typesDir)) {
        const file = join(typesDir, name, "schema.json");
        if (existsSync(file)) {
          contentTypes[`api::${api}.${name}`] = JSON.parse(
            readFileSync(file, "utf8"),
          ) as DraftTwinModel;
        }
      }
    }
    expect(planDraftTwinTypes(contentTypes)).toEqual({
      order: [
        ANNOUNCEMENT,
        COURSE,
        "api::document.document",
        "api::event.event",
        LESSON,
        "api::poll.poll",
        "api::quick-link.quick-link",
        "api::wiki-page.wiki-page",
        "api::wiki-space.wiki-space",
      ],
      cyclic: [],
    });
  });
});

// --- fake Strapi ---------------------------------------------------------------

interface FakeFields {
  documentId: string;
  locale?: string | null;
  publishedAt: string | null;
  /** Other fields, e.g. a relation stored as it comes back populated. */
  [field: string]: unknown;
}

/** A stored row: a draft-twin row plus its other fields. */
interface FakeRow extends FakeFields, DraftTwinRow {
  id: number;
}

type Where = Record<string, unknown>;

function matches(row: FakeRow, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = (row as unknown as Record<string, unknown>)[key] ?? null;
    if (condition !== null && typeof condition === "object") {
      const ops = condition as Record<string, unknown>;
      if ("$notNull" in ops) return ops.$notNull ? value !== null : value === null;
      if ("$null" in ops) return ops.$null ? value === null : value !== null;
      if ("$gt" in ops) return typeof value === "number" && value > Number(ops.$gt);
      if ("$in" in ops) return (ops.$in as unknown[]).includes(value);
      throw new Error(`fake: unsupported operator ${Object.keys(ops).join()}`);
    }
    return value === condition;
  });
}

interface FakeOptions {
  contentTypes?: Record<string, DraftTwinModel>;
  /** Rows without an id get one from 1000 up. */
  rows?: Record<string, Array<FakeFields & { id?: number }>>;
  /** documentIds whose discardDraft throws. */
  failing?: string[];
  /** uid whose findMany throws. */
  brokenQuery?: string;
  /** uid without a discardDraft method. */
  noDiscard?: string;
  /** Called at the start of every transaction (to simulate a concurrent write). */
  onTransaction?: (tables: Map<string, FakeRow[]>) => void;
}

function fakeStrapi(options: FakeOptions = {}) {
  let nextId = 1000;
  const tables = new Map<string, FakeRow[]>();
  for (const [uid, rows] of Object.entries(options.rows ?? {})) {
    tables.set(
      uid,
      rows.map((row) => ({ locale: null, ...row, id: row.id ?? nextId++ })),
    );
  }
  const table = (uid: string) => {
    if (!tables.has(uid)) tables.set(uid, []);
    return tables.get(uid) as FakeRow[];
  };
  const calls = {
    findOne: [] as Array<{ uid: string; params: Record<string, unknown> }>,
    findMany: [] as Array<{ uid: string; params: Record<string, unknown> }>,
    discardDraft: [] as Array<{ uid: string; params: { documentId: string; locale?: string } }>,
    transactions: 0,
  };
  const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  let inTransaction = false;

  const strapi: DraftTwinsHost = {
    contentTypes: options.contentTypes ?? { [ANNOUNCEMENT]: dp() },
    db: {
      query: (uid) => ({
        // Relations are stored on the fake rows as they come back populated.
        findOne: async (params) => {
          calls.findOne.push({ uid, params });
          const row = table(uid).find((candidate) => matches(candidate, params.where as Where));
          return row ? { ...row } : null;
        },
        findMany: async (params) => {
          calls.findMany.push({ uid, params });
          if (options.brokenQuery === uid) throw new Error("relation does not exist");
          let rows = table(uid).filter((row) => matches(row, params.where as Where));
          if (params.orderBy) rows = [...rows].sort((a, b) => a.id - b.id);
          if (typeof params.limit === "number") rows = rows.slice(0, params.limit);
          return rows.map((row) => ({ ...row }));
        },
        count: async (params) =>
          table(uid).filter((row) => matches(row, params.where as Where)).length,
      }),
      transaction: async (callback) => {
        if (inTransaction) throw new Error("fake: the repair must not nest its own transactions");
        calls.transactions++;
        options.onTransaction?.(tables);
        const snapshot = new Map(
          [...tables].map(([uid, rows]) => [uid, rows.map((row) => ({ ...row }))]),
        );
        inTransaction = true;
        try {
          return await callback();
        } catch (err) {
          tables.clear();
          for (const [uid, rows] of snapshot) tables.set(uid, rows);
          throw err;
        } finally {
          inTransaction = false;
        }
      },
    },
    documents: (uid) => ({
      discardDraft:
        options.noDiscard === uid
          ? undefined
          : async (params) => {
              if (!inTransaction) throw new Error("fake: discardDraft outside the transaction");
              calls.discardDraft.push({ uid, params });
              const rows = table(uid);
              const sameLocale = (row: FakeRow) =>
                params.locale === undefined ? true : row.locale === params.locale;
              // Strapi: delete the old drafts, then clone every published row.
              const kept = rows.filter(
                (row) =>
                  !(
                    row.documentId === params.documentId &&
                    row.publishedAt === null &&
                    sameLocale(row)
                  ),
              );
              const published = kept.filter(
                (row) =>
                  row.documentId === params.documentId &&
                  row.publishedAt !== null &&
                  sameLocale(row),
              );
              kept.push(...published.map((row) => ({ ...row, id: nextId++, publishedAt: null })));
              tables.set(uid, kept);
              if (options.failing?.includes(params.documentId))
                throw new Error("validation failed");
              return { documentId: params.documentId, entries: [] };
            },
    }),
    log: {
      info: (message) => logs.info.push(message),
      warn: (message) => logs.warn.push(message),
      error: (message) => logs.error.push(message),
    },
  };

  const drafts = (uid: string) =>
    table(uid)
      .filter((row) => row.publishedAt === null)
      .map((row) => `${row.documentId}${row.locale ? `/${row.locale}` : ""}`)
      .sort();
  return { strapi, calls, logs, tables, drafts };
}

const PUBLISHED = "2026-09-01T10:00:00.000Z";
const published = (documentId: string, extra: Partial<FakeRow> = {}) => ({
  documentId,
  publishedAt: PUBLISHED,
  ...extra,
});
const draft = (documentId: string, extra: Partial<FakeRow> = {}) => ({
  documentId,
  publishedAt: null,
  ...extra,
});

// --- selection -------------------------------------------------------------------

describe("findPublishedOnlyRows", () => {
  it("returns the published rows of the page that have no draft of the same document and locale", async () => {
    const { strapi } = fakeStrapi({
      rows: {
        [ANNOUNCEMENT]: [
          published("a", { id: 1 }),
          draft("b", { id: 2 }),
          published("b", { id: 3 }),
          published("c", { id: 4, locale: "en" }),
          published("c", { id: 5, locale: "de" }),
          draft("c", { id: 6, locale: "en" }),
          published("a", { id: 7 }),
        ],
      },
    });
    const { page, missing } = await findPublishedOnlyRows(strapi, ANNOUNCEMENT, 0, 100);
    expect(page.map((row) => row.id)).toEqual([1, 3, 4, 5, 7]);
    // "a" twice (anomaly) is listed once; "c/en" has its draft, "c/de" not.
    expect(missing.map((row) => `${row.documentId}/${row.locale ?? "-"}`)).toEqual(["a/-", "c/de"]);
  });

  it("reads published rows in id order after the given id, then drafts of those documents only", async () => {
    const { strapi, calls } = fakeStrapi({
      rows: {
        [ANNOUNCEMENT]: [
          published("a", { id: 1 }),
          published("b", { id: 2 }),
          published("c", { id: 3 }),
        ],
      },
    });
    await findPublishedOnlyRows(strapi, ANNOUNCEMENT, 1, 1);
    expect(calls.findMany).toEqual([
      {
        uid: ANNOUNCEMENT,
        params: {
          select: ["id", "documentId", "locale"],
          where: { publishedAt: { $notNull: true }, id: { $gt: 1 } },
          orderBy: { id: "asc" },
          limit: 1,
        },
      },
      {
        uid: ANNOUNCEMENT,
        params: {
          select: ["id", "documentId", "locale"],
          where: { publishedAt: { $null: true }, documentId: { $in: ["b"] } },
        },
      },
    ]);
  });

  it("does not query drafts for an empty page", async () => {
    const { strapi, calls } = fakeStrapi({ rows: { [ANNOUNCEMENT]: [] } });
    expect(await findPublishedOnlyRows(strapi, ANNOUNCEMENT, 0, 10)).toEqual({
      page: [],
      missing: [],
    });
    expect(calls.findMany).toHaveLength(1);
  });
});

// --- ensureDraftTwins -------------------------------------------------------------

describe("ensureDraftTwins", () => {
  it("creates one draft per published-only document and leaves existing drafts alone", async () => {
    const { strapi, calls, logs, drafts, tables } = fakeStrapi({
      rows: {
        [ANNOUNCEMENT]: [
          published("seed-1"),
          published("seed-2"),
          draft("admin-1", { title: "pending edit" } as Partial<FakeRow>),
          published("admin-1"),
          draft("never-published"),
        ],
      },
    });
    const reports = await ensureDraftTwins(strapi);
    expect(reports).toEqual([{ uid: ANNOUNCEMENT, created: 2, failed: 0, capped: false }]);
    expect(drafts(ANNOUNCEMENT)).toEqual(["admin-1", "never-published", "seed-1", "seed-2"]);
    // The pending edit is untouched (discardDraft would have replaced it).
    expect(calls.discardDraft.map((call) => call.params)).toEqual([
      { documentId: "seed-1" },
      { documentId: "seed-2" },
    ]);
    const adminDraft = tables
      .get(ANNOUNCEMENT)
      ?.find((row) => row.documentId === "admin-1" && !row.publishedAt);
    expect((adminDraft as unknown as { title?: string })?.title).toBe("pending edit");
    expect(logs.info).toEqual([`[draft-twins] created 2 draft(s) for ${ANNOUNCEMENT}`]);
    expect(logs.warn).toEqual([]);
    expect(logs.error).toEqual([]);
  });

  it("is idempotent: a second run creates nothing and logs nothing", async () => {
    const { strapi, calls, logs } = fakeStrapi({
      rows: { [ANNOUNCEMENT]: [published("a"), published("b")] },
    });
    await ensureDraftTwins(strapi);
    const before = calls.discardDraft.length;
    logs.info.length = 0;
    const reports = await ensureDraftTwins(strapi);
    expect(calls.discardDraft).toHaveLength(before);
    expect(reports).toEqual([{ uid: ANNOUNCEMENT, created: 0, failed: 0, capped: false }]);
    expect(logs.info).toEqual([]);
  });

  it("passes the locale of a localized row and none for a non-localized one", async () => {
    const { strapi, calls, drafts } = fakeStrapi({
      rows: {
        [ANNOUNCEMENT]: [
          published("i18n", { locale: "en" }),
          published("i18n", { locale: "de" }),
          draft("i18n", { locale: "en" }),
          published("plain"),
        ],
      },
    });
    await ensureDraftTwins(strapi);
    expect(calls.discardDraft.map((call) => call.params)).toEqual([
      { documentId: "i18n", locale: "de" },
      { documentId: "plain" },
    ]);
    expect(drafts(ANNOUNCEMENT)).toEqual(["i18n/de", "i18n/en", "plain"]);
  });

  it("walks every page of published rows", async () => {
    const ids = ["a", "b", "c", "d", "e"];
    const { strapi, calls, drafts } = fakeStrapi({
      rows: {
        [ANNOUNCEMENT]: ids.map((documentId, index) => published(documentId, { id: index + 1 })),
      },
    });
    const [report] = await ensureDraftTwins(strapi, { batchSize: 2 });
    expect(report.created).toBe(5);
    expect(drafts(ANNOUNCEMENT)).toEqual(ids);
    const pageQueries = calls.findMany.filter((call) => "limit" in call.params);
    expect(
      pageQueries.map((call) => (call.params.where as { id: { $gt: number } }).id.$gt),
    ).toEqual([0, 2, 4]);
  });

  it("re-checks inside the transaction and never replaces a draft that appeared meanwhile", async () => {
    let injected = false;
    const { strapi, calls, drafts } = fakeStrapi({
      rows: { [ANNOUNCEMENT]: [published("a"), published("b")] },
      onTransaction: (tables) => {
        if (injected) return;
        injected = true;
        tables.get(ANNOUNCEMENT)?.push({ id: 1, documentId: "a", locale: null, publishedAt: null });
      },
    });
    const [report] = await ensureDraftTwins(strapi);
    expect(report.created).toBe(1);
    expect(calls.discardDraft.map((call) => call.params.documentId)).toEqual(["b"]);
    expect(drafts(ANNOUNCEMENT)).toEqual(["a", "b"]);
  });

  it("logs a failing document, rolls it back and carries on (fail-open)", async () => {
    const { strapi, logs, drafts } = fakeStrapi({
      rows: { [ANNOUNCEMENT]: [published("ok-1"), published("bad"), published("ok-2")] },
      failing: ["bad"],
    });
    const reports = await ensureDraftTwins(strapi);
    expect(reports).toEqual([{ uid: ANNOUNCEMENT, created: 2, failed: 1, capped: false }]);
    // The half-written draft of "bad" was rolled back with its transaction.
    expect(drafts(ANNOUNCEMENT)).toEqual(["ok-1", "ok-2"]);
    expect(logs.error).toEqual([
      `[draft-twins] ${ANNOUNCEMENT} bad: could not create the draft (validation failed); the next boot retries`,
    ]);
    expect(logs.info).toEqual([`[draft-twins] created 2 draft(s) for ${ANNOUNCEMENT}, 1 failed`]);
  });

  it("logs a type whose query fails and still repairs the next type", async () => {
    const { strapi, logs, drafts } = fakeStrapi({
      contentTypes: { [ANNOUNCEMENT]: dp(), [COURSE]: dp() },
      rows: { [ANNOUNCEMENT]: [published("a")], [COURSE]: [published("c")] },
      brokenQuery: ANNOUNCEMENT,
    });
    await expect(ensureDraftTwins(strapi)).resolves.toEqual([
      { uid: ANNOUNCEMENT, created: 0, failed: 0, capped: false },
      { uid: COURSE, created: 1, failed: 0, capped: false },
    ]);
    expect(logs.error).toEqual([
      `[draft-twins] ${ANNOUNCEMENT}: repair stopped (relation does not exist); the next boot retries`,
    ]);
    expect(drafts(COURSE)).toEqual(["c"]);
  });

  it("reports a type without discardDraft per document instead of throwing", async () => {
    const { strapi, logs } = fakeStrapi({
      rows: { [ANNOUNCEMENT]: [published("a")] },
      noDiscard: ANNOUNCEMENT,
    });
    await expect(ensureDraftTwins(strapi)).resolves.toEqual([
      { uid: ANNOUNCEMENT, created: 0, failed: 1, capped: false },
    ]);
    expect(logs.error[0]).toMatch(/has no discardDraft/);
  });

  it("stops a type at the per-boot cap and finishes on the next boot", async () => {
    const { strapi, logs, drafts } = fakeStrapi({
      rows: { [ANNOUNCEMENT]: [published("a"), published("b"), published("c")] },
    });
    expect(await ensureDraftTwins(strapi, { maxPerType: 2 })).toEqual([
      { uid: ANNOUNCEMENT, created: 2, failed: 0, capped: true },
    ]);
    expect(logs.warn).toEqual([
      `[draft-twins] ${ANNOUNCEMENT}: stopped after 2 document(s) on this boot; the next boot continues`,
    ]);
    expect(await ensureDraftTwins(strapi, { maxPerType: 2 })).toEqual([
      { uid: ANNOUNCEMENT, created: 1, failed: 0, capped: false },
    ]);
    expect(drafts(ANNOUNCEMENT)).toEqual(["a", "b", "c"]);
  });

  it("never touches wiki revisions", async () => {
    const { strapi, calls, drafts } = fakeStrapi({
      contentTypes: { [ANNOUNCEMENT]: dp(), [REVISION]: dp() },
      rows: { [ANNOUNCEMENT]: [published("a")], [REVISION]: [published("r1"), published("r2")] },
    });
    await ensureDraftTwins(strapi);
    expect(calls.discardDraft.map((call) => call.uid)).toEqual([ANNOUNCEMENT]);
    expect(calls.findMany.map((call) => call.uid)).not.toContain(REVISION);
    expect(drafts(REVISION)).toEqual([]);
  });

  it("repairs the target of a unidirectional relation before its source", async () => {
    const { strapi, calls } = fakeStrapi({
      contentTypes: {
        "api::a.a": dp({ b: { type: "relation", relation: "manyToOne", target: "api::b.b" } }),
        "api::b.b": dp(),
      },
      rows: { "api::a.a": [published("a1")], "api::b.b": [published("b1")] },
    });
    await ensureDraftTwins(strapi);
    expect(calls.discardDraft.map((call) => call.uid)).toEqual(["api::b.b", "api::a.a"]);
  });

  it("warns about a unidirectional cycle and still repairs its types", async () => {
    const { strapi, logs, calls } = fakeStrapi({
      contentTypes: {
        "api::x.x": dp({ y: { type: "relation", relation: "manyToOne", target: "api::y.y" } }),
        "api::y.y": dp({ x: { type: "relation", relation: "manyToOne", target: "api::x.x" } }),
      },
      rows: { "api::x.x": [published("x1")], "api::y.y": [published("y1")] },
    });
    await ensureDraftTwins(strapi);
    expect(logs.warn).toEqual([
      "[draft-twins] unidirectional relations form a cycle between api::x.x, api::y.y; " +
        "a draft may miss a link to a document of that cycle that had no draft yet",
    ]);
    expect(calls.discardDraft.map((call) => call.uid)).toEqual(["api::x.x", "api::y.y"]);
  });

  it("never throws, even when the content-type registry does", async () => {
    const { strapi, logs } = fakeStrapi();
    Object.defineProperty(strapi, "contentTypes", {
      get: () => {
        throw new Error("registry not ready");
      },
    });
    await expect(ensureDraftTwins(strapi)).resolves.toEqual([]);
    expect(logs.error).toEqual(["[draft-twins] could not plan the repair: registry not ready"]);
  });

  it("runs one transaction per repaired document and none on a steady-state boot", async () => {
    const { strapi, calls } = fakeStrapi({
      rows: { [ANNOUNCEMENT]: [published("a"), published("b"), draft("c"), published("c")] },
    });
    await ensureDraftTwins(strapi);
    expect(calls.transactions).toBe(2);
    await ensureDraftTwins(strapi);
    expect(calls.transactions).toBe(2);
  });
});

// --- pending moves --------------------------------------------------------------

describe("ensureDraftTwins and pending drafts of linked documents", () => {
  // course.lessons is the "one" side of course ↔ lesson; wiki-page.children
  // the "one" side of the parent/children self relation.
  const courseLesson = {
    [COURSE]: dp({
      title: { type: "string" },
      lessons: { type: "relation", relation: "oneToMany", target: LESSON, mappedBy: "course" },
    }),
    [LESSON]: dp({
      course: { type: "relation", relation: "manyToOne", target: COURSE, inversedBy: "lessons" },
    }),
  };
  const linkTo = (documentId: string) => ({ documentId });

  it("refuses a document whose clone would move another document's pending draft", async () => {
    const { strapi, calls, logs, drafts, tables } = fakeStrapi({
      contentTypes: courseLesson,
      rows: {
        [COURSE]: [
          published("seeded", { id: 1, lessons: [linkTo("moved"), linkTo("stays")] }),
          published("admin", { id: 2 }),
          draft("admin", { id: 3 }),
          published("seeded-2", { id: 4, lessons: [linkTo("stays-2")] }),
        ],
        [LESSON]: [
          published("moved", { id: 10, course: linkTo("seeded") }),
          // The admin saved (did not publish) a move to the admin course.
          draft("moved", { id: 11, course: linkTo("admin") }),
          published("stays", { id: 12, course: linkTo("seeded") }),
          published("stays-2", { id: 13, course: linkTo("seeded-2") }),
        ],
      },
    });
    const reports = await ensureDraftTwins(strapi);
    expect(reports).toEqual([
      { uid: COURSE, created: 1, failed: 1, capped: false },
      { uid: LESSON, created: 2, failed: 0, capped: false },
    ]);
    // "seeded" got no draft; the other course and the lessons without a
    // pending draft were repaired.
    expect(calls.discardDraft.map((call) => `${call.uid} ${call.params.documentId}`)).toEqual([
      `${COURSE} seeded-2`,
      `${LESSON} stays`,
      `${LESSON} stays-2`,
    ]);
    expect(drafts(COURSE)).toEqual(["admin", "seeded-2"]);
    expect(drafts(LESSON)).toEqual(["moved", "stays", "stays-2"]);
    const pending = tables.get(LESSON)?.find((row) => row.id === 11);
    expect(pending?.course).toEqual(linkTo("admin"));
    expect(logs.error).toEqual([
      `[draft-twins] ${COURSE} seeded: could not create the draft (the pending draft of ${LESSON} moved ` +
        "links another course (admin); publish or discard that draft); the next boot retries",
    ]);
  });

  it("reads the published row's links and the targets' drafts with their back link", async () => {
    const { strapi, calls } = fakeStrapi({
      contentTypes: courseLesson,
      rows: {
        [COURSE]: [
          published("seeded", { id: 1, lessons: [linkTo("a"), linkTo("b"), linkTo("a")] }),
        ],
        [LESSON]: [],
      },
    });
    await ensureDraftTwins(strapi);
    expect(calls.findOne).toEqual([
      {
        uid: COURSE,
        params: { where: { id: 1 }, populate: { lessons: { select: ["documentId"] } } },
      },
    ]);
    expect(calls.findMany.filter((call) => "populate" in call.params)).toEqual([
      {
        uid: LESSON,
        params: {
          select: ["id", "documentId"],
          where: { documentId: { $in: ["a", "b"] }, publishedAt: { $null: true } },
          populate: { course: { select: ["documentId"] } },
        },
      },
    ]);
  });

  it("re-links drafts that link no document or this one, and ignores published-only targets", async () => {
    const { strapi, calls, logs } = fakeStrapi({
      contentTypes: courseLesson,
      rows: {
        [COURSE]: [
          published("seeded", {
            id: 1,
            lessons: [linkTo("unlinked"), linkTo("same"), linkTo("published-only")],
          }),
        ],
        [LESSON]: [
          published("unlinked", { course: linkTo("seeded") }),
          // A form-only save dropped the link: re-attaching restores it.
          draft("unlinked", { course: null }),
          published("same", { course: linkTo("seeded") }),
          draft("same", { course: linkTo("seeded") }),
          published("published-only", { course: linkTo("seeded") }),
        ],
      },
    });
    await ensureDraftTwins(strapi);
    expect(calls.discardDraft.map((call) => `${call.uid} ${call.params.documentId}`)).toEqual([
      `${COURSE} seeded`,
      `${LESSON} published-only`,
    ]);
    expect(logs.error).toEqual([]);
  });

  it("covers self relations (wiki-page children) and leaves types without such a relation alone", async () => {
    const PAGE = "api::wiki-page.wiki-page";
    const { strapi, calls, logs } = fakeStrapi({
      contentTypes: {
        [ANNOUNCEMENT]: dp({
          author: {
            type: "relation",
            relation: "oneToOne",
            target: "plugin::users-permissions.user",
          },
        }),
        [PAGE]: dp({
          parent: { type: "relation", relation: "manyToOne", target: PAGE, inversedBy: "children" },
          children: { type: "relation", relation: "oneToMany", target: PAGE, mappedBy: "parent" },
          revisions: {
            type: "relation",
            relation: "oneToMany",
            target: REVISION,
            mappedBy: "page",
          },
        }),
        [REVISION]: dp({
          page: { type: "relation", relation: "manyToOne", target: PAGE, inversedBy: "revisions" },
        }),
      },
      rows: {
        [ANNOUNCEMENT]: [published("news")],
        [PAGE]: [
          published("root", { id: 1, children: [linkTo("child")], revisions: [linkTo("r1")] }),
          published("child", { id: 2, parent: linkTo("root") }),
          draft("child", { id: 3, parent: linkTo("elsewhere") }),
          published("elsewhere", { id: 4 }),
          draft("elsewhere", { id: 5 }),
        ],
        [REVISION]: [published("r1", { page: linkTo("root") })],
      },
    });
    await ensureDraftTwins(strapi);
    expect(calls.findOne.map((call) => call.uid)).toEqual([PAGE]);
    expect(calls.discardDraft.map((call) => `${call.uid} ${call.params.documentId}`)).toEqual([
      `${ANNOUNCEMENT} news`,
    ]);
    expect(logs.error).toEqual([
      `[draft-twins] ${PAGE} root: could not create the draft (the pending draft of ${PAGE} child ` +
        "links another parent (elsewhere); publish or discard that draft); the next boot retries",
    ]);
  });

  it("repairs the document on the next boot once the pending draft is gone", async () => {
    const { strapi, calls, tables } = fakeStrapi({
      contentTypes: courseLesson,
      rows: {
        [COURSE]: [published("seeded", { id: 1, lessons: [linkTo("moved")] })],
        [LESSON]: [
          published("moved", { id: 10, course: linkTo("seeded") }),
          draft("moved", { id: 11, course: linkTo("admin") }),
        ],
      },
    });
    await ensureDraftTwins(strapi);
    expect(calls.discardDraft).toEqual([]);
    // The admin discards the pending move.
    tables.set(
      LESSON,
      (tables.get(LESSON) ?? []).filter((row) => row.id !== 11),
    );
    const reports = await ensureDraftTwins(strapi);
    expect(reports[0]).toEqual({ uid: COURSE, created: 1, failed: 0, capped: false });
  });
});
