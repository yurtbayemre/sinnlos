import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSqliteEngine, type SqliteEngine } from "./sqlite-engine.test.helper";
import {
  createEvaluator,
  createStrapiStub,
  matchWhere,
  policyContext,
  stubDocumentId,
  type ContentTypeSchema,
  type DocumentParams,
  type Row,
  type Where,
} from "./strapi-stub.test.helper";

/**
 * The shared stub (S03) is only worth something while it answers like the
 * real query engine. The parity block runs every where clause, select and
 * populate below against @strapi/database 5.55.1 on SQLite AND against the
 * stub, seeded with the same rows, and requires the same result. A clause
 * the stub gets wrong fails here, not silently in a policy test.
 */

const GROUP = "api::group.group";
const TAG = "api::tag.tag";
const THING = "api::thing.thing";

const MODELS = [
  {
    uid: GROUP,
    singularName: "group",
    tableName: "groups",
    attributes: { id: { type: "increments" }, name: { type: "string" } },
  },
  {
    uid: TAG,
    singularName: "tag",
    tableName: "tags",
    attributes: { id: { type: "increments" }, label: { type: "string" } },
  },
  {
    uid: THING,
    singularName: "thing",
    tableName: "things",
    attributes: {
      id: { type: "increments" },
      name: { type: "string" },
      rank: { type: "integer" },
      note: { type: "string" },
      group: { type: "relation", relation: "manyToOne", target: GROUP },
      tags: { type: "relation", relation: "manyToMany", target: TAG },
    },
  },
];

const GROUPS = [
  { id: 1, name: "G1" },
  { id: 2, name: "G2" },
];
const TAGS = [
  { id: 1, label: "red" },
  { id: 2, label: "blue" },
];
const THINGS = [
  { id: 1, name: "alpha", rank: 1, note: "x", group: 1, tags: [1, 2] },
  { id: 2, name: "beta", rank: 2, note: null, group: 2, tags: [2] },
  { id: 3, name: "gamma", rank: 3, note: "y", group: null, tags: [] },
  { id: 4, name: "delta", rank: null, note: "x", group: 1, tags: [1] },
];

/** The stub's rows: relations embedded as the query engine would populate them. */
function stubThings(): Row[] {
  return THINGS.map((thing) => ({
    ...thing,
    group: GROUPS.find((group) => group.id === thing.group) ?? null,
    tags: thing.tags
      .map((id) => TAGS.find((tag) => tag.id === id))
      .filter((tag) => tag !== undefined),
  }));
}

const WHERE_CASES: Array<[string, Where]> = [
  ["no filter", {}],
  ["scalar shorthand", { name: "alpha" }],
  ["array shorthand = any of", { name: ["alpha", "gamma"] }],
  ["$eq", { rank: { $eq: 2 } }],
  ["$eq null = IS NULL", { note: { $eq: null } }],
  ["null shorthand", { note: null }],
  ["$ne never matches NULL", { note: { $ne: "x" } }],
  ["$ne null = IS NOT NULL", { note: { $ne: null } }],
  ["$in", { id: { $in: [1, 3] } }],
  ["$in [] matches nothing", { id: { $in: [] } }],
  ["$notIn", { id: { $notIn: [1] } }],
  ["$notIn [] matches everything", { id: { $notIn: [] } }],
  ["$null true", { note: { $null: true } }],
  ["$null false", { note: { $null: false } }],
  ["$notNull true", { rank: { $notNull: true } }],
  ["$notNull false", { rank: { $notNull: false } }],
  ["$lt never matches NULL", { rank: { $lt: 3 } }],
  ["$lte", { rank: { $lte: 2 } }],
  ["$gt", { rank: { $gt: 1 } }],
  ["$gte", { rank: { $gte: 2 } }],
  ["two operators on one column", { rank: { $gt: 1, $lt: 3 } }],
  ["numeric string id", { id: "2" }],
  ["two columns = AND", { name: { $in: ["alpha", "delta"] }, note: "x", rank: 1 }],
  ["$and", { $and: [{ rank: { $gte: 1 } }, { note: "x" }] }],
  ["$or", { $or: [{ name: "alpha" }, { rank: { $gt: 2 } }] }],
  ["$not on a column", { $not: { name: "beta" } }],
  [
    "nested $and/$or",
    { $or: [{ $and: [{ note: "x" }, { rank: { $null: true } }] }, { name: "beta" }] },
  ],
  ["to-one by id", { group: { id: 1 } }],
  ["to-one scalar = related id", { group: 2 }],
  ["to-one by column", { group: { name: "G2" } }],
  ["to-one $null (LEFT JOIN)", { group: { $null: true } }],
  ["to-one $in on the related id", { group: { $in: [2] } }],
  ["to-one id $in", { group: { id: { $in: [1, 2] } } }],
  ["to-many: any related row", { tags: { label: "red" } }],
  ["to-many id $in", { tags: { id: { $in: [2] } } }],
  ["to-many $or inside the relation", { tags: { $or: [{ label: "red" }, { label: "green" }] } }],
  ["to-one related column IS NULL (LEFT JOIN)", { group: { id: { $null: true } } }],
  ["to-many related column IS NULL (LEFT JOIN)", { tags: { id: { $null: true } } }],
  ["to-many $ne runs per joined row", { tags: { label: { $ne: "red" } } }],
  ["relation and column", { $and: [{ group: { id: 1 } }, { rank: { $notNull: true } }] }],
];

let engine: SqliteEngine;

beforeAll(async () => {
  engine = await openSqliteEngine(MODELS);
  for (const group of GROUPS) await engine.db.query(GROUP).create({ data: { name: group.name } });
  for (const tag of TAGS) await engine.db.query(TAG).create({ data: { label: tag.label } });
  for (const { id: _id, ...thing } of THINGS) await engine.db.query(THING).create({ data: thing });
});

afterAll(async () => {
  await engine.close();
});

/** The same models as stub schemas, so relations are known even where empty. */
const SCHEMAS: Record<string, ContentTypeSchema> = Object.fromEntries(
  MODELS.map((model) => [model.uid, { uid: model.uid, attributes: model.attributes }]),
);

const stub = () => createStrapiStub({ tables: { [THING]: stubThings() }, schemas: SCHEMAS });

/** The same data with relations as bare references into the group/tag tables. */
const referencingStub = () =>
  createStrapiStub({
    tables: {
      [GROUP]: GROUPS,
      [TAG]: TAGS,
      [THING]: THINGS.map((thing) => ({
        ...thing,
        group: thing.group === null ? null : { id: thing.group },
        tags: thing.tags.map((id) => ({ id })),
      })),
    },
    schemas: SCHEMAS,
  });

describe("strapi-stub where evaluator = @strapi/database 5.55.1 on SQLite", () => {
  it.each(WHERE_CASES)("%s", async (_label, where) => {
    const params = { where, select: ["id"], orderBy: { id: "asc" as const } };
    const real = (await engine.db.query(THING).findMany(params)).map((row) => row.id);
    const embedded = (await stub().db.query(THING).findMany(params)).map((row) => row.id);
    const referenced = (await referencingStub().db.query(THING).findMany(params)).map(
      (row) => row.id,
    );
    expect(embedded).toEqual(real);
    expect(referenced).toEqual(real);
  });

  it("refuses what it does not model instead of guessing", () => {
    const { matchWhere: match } = createEvaluator(SCHEMAS);
    const row: Row = { id: 1, name: "a", tags: [{ id: 1, label: "red" }] };
    expect(() => match(THING, row, { name: { $containsi: "A" } })).toThrow(/not modelled/);
    // SQL applies NOT per joined row: the engine answers 1, 2 and 4 here (1
    // has a non-red tag, 3 has no joined row at all); "not any red" would say 2 and 3.
    expect(() => match(THING, row, { $not: { tags: { label: "red" } } })).toThrow(/not modelled/);
    expect(() => match(THING, { id: 3, tags: [] }, { $not: { tags: { label: "red" } } })).toThrow(
      /not modelled/,
    );
    expect(() => match(THING, row, { $eq: 1 })).toThrow(/root level/);
    // Column operators only: $or belongs at root level (the engine throws too).
    expect(() => match(THING, row, { name: { $or: ["a", "b"] } })).toThrow(/not modelled/);
  });

  it("uses the real schemas for real uids (matchWhere export)", () => {
    const user: Row = { id: 7, department: null, teams: [] };
    expect(
      matchWhere("plugin::users-permissions.user", user, { department: { id: { $null: true } } }),
    ).toBe(true);
    expect(matchWhere("plugin::users-permissions.user", user, { teams: { id: 3 } })).toBe(false);
  });
});

describe("strapi-stub projection = the query engine's", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["no select, no populate: scalars only", { where: { id: 1 } }],
    ["select without id", { where: { id: 1 }, select: ["name"] }],
    [
      "select + populate adds the id",
      { where: { id: 1 }, select: ["name"], populate: { group: true } },
    ],
    [
      "nested select",
      { where: { id: 1 }, populate: { group: { select: ["name"] }, tags: { select: ["label"] } } },
    ],
    ["populate: true", { where: { id: 1 }, populate: true }],
    ["populate as a list", { where: { id: 3 }, populate: ["group", "tags"] }],
    [
      "populate with a where",
      { where: { id: 1 }, populate: { tags: { where: { label: "blue" } } } },
    ],
  ];

  it.each(cases)("%s", async (_label, params) => {
    const real = await engine.db.query(THING).findOne(params);
    expect(await stub().db.query(THING).findOne(params)).toEqual(real);
    expect(await referencingStub().db.query(THING).findOne(params)).toEqual(real);
  });

  it("orders, limits and offsets like the engine (NULLs first ascending)", async () => {
    for (const params of [
      { orderBy: { rank: "asc" }, select: ["id"] },
      { orderBy: { rank: "desc" }, select: ["id"] },
      { orderBy: [{ note: "asc" }, { id: "desc" }], select: ["id"] },
      { orderBy: { id: "asc" }, limit: 2, offset: 1, select: ["id"] },
      // knex takes the direction in either case; a bare string sorts ascending.
      { orderBy: { name: "DESC" }, select: ["id"] },
      { orderBy: "rank", select: ["id"] },
      { orderBy: ["note", { id: "desc" }], select: ["id"] },
      { where: { id: 1 }, populate: { tags: { orderBy: { label: "DESC" } } } },
    ]) {
      const real = await engine.db.query(THING).findMany(params);
      const fake = await stub()
        .db.query(THING)
        .findMany(params as never);
      expect(fake, JSON.stringify(params)).toEqual(real);
    }
  });

  it("throws on an orderBy the engine refuses: unknown column, a 'field:dir' string", async () => {
    for (const orderBy of [
      { nope: "desc" },
      "nope",
      "rank:desc",
      [{ rank: "asc" }, { nope: "asc" }],
      { tags: "asc" },
    ]) {
      const params = { orderBy, select: ["id"] } as never;
      await expect(
        engine.db.query(THING).findMany(params),
        JSON.stringify(orderBy),
      ).rejects.toThrow(/not found on model/);
      await expect(
        stub().db.query(THING).findMany(params),
        JSON.stringify(orderBy),
      ).rejects.toThrow(/strapi-stub: orderBy/);
    }
    const nested = { where: { id: 1 }, populate: { tags: { orderBy: { nope: "asc" } } } } as never;
    await expect(engine.db.query(THING).findMany(nested)).rejects.toThrow(/nope not found/);
    await expect(stub().db.query(THING).findMany(nested)).rejects.toThrow(/unknown column nope/);
  });

  it("throws on an orderBy it does not model instead of keeping insertion order", async () => {
    // The engine joins and orders by the related column; the stub does not model that.
    const throughRelation = { orderBy: { group: { name: "desc" } }, select: ["id"] } as never;
    expect(await engine.db.query(THING).findMany(throughRelation)).toHaveLength(4);
    await expect(stub().db.query(THING).findMany(throughRelation)).rejects.toThrow(
      /relation group is not modelled/,
    );
    for (const orderBy of [{ rank: "sideways" }, { status: "asc" }, 42]) {
      await expect(
        stub()
          .db.query(THING)
          .findMany({ orderBy } as never),
        JSON.stringify(orderBy),
      ).rejects.toThrow(/strapi-stub: orderBy/);
    }
    // The implicit columns every content type has are known without a schema entry.
    const { sortRows } = createEvaluator(SCHEMAS);
    const rows: Row[] = [
      { id: 1, createdAt: "2026-01-02" },
      { id: 2, createdAt: "2026-01-03" },
    ];
    expect(sortRows(THING, rows, { createdAt: "desc" }).map((row) => row.id)).toEqual([2, 1]);
  });

  it("counts and misses like the engine", async () => {
    expect(
      await stub()
        .db.query(THING)
        .count({ where: { rank: { $gte: 2 } } }),
    ).toBe(await engine.db.query(THING).count({ where: { rank: { $gte: 2 } } }));
    expect(
      await stub()
        .db.query(THING)
        .findOne({ where: { name: "zzz" } }),
    ).toBeNull();
    expect(await engine.db.query(THING).findOne({ where: { name: "zzz" } })).toBeNull();
  });
});

describe("strapi-stub writes", () => {
  it("creates with the next id, stores a bare relation id as { id }, updates and deletes", async () => {
    const strapi = createStrapiStub({
      tables: { "api::notification.notification": [{ id: 4, title: "old", recipient: { id: 7 } }] },
    });
    const query = strapi.db.query("api::notification.notification");
    const created = await query.create({
      data: { title: "new", recipient: 8 },
      populate: { recipient: true },
    });
    expect(created).toEqual({ id: 5, title: "new", recipient: { id: 8 } });
    expect(await query.findMany({ where: { recipient: { id: 8 } }, select: ["id"] })).toEqual([
      { id: 5 },
    ]);

    expect(await query.update({ where: { id: 4 }, data: { title: "changed" } })).toEqual({
      id: 4,
      title: "changed",
    });
    expect(
      await query.updateMany({
        where: { title: { $in: ["changed", "new"] } },
        data: { read: true },
      }),
    ).toEqual({
      count: 2,
    });
    expect(await query.delete({ where: { id: 4 } })).toMatchObject({ id: 4 });
    expect(await query.deleteMany({ where: { read: true } })).toEqual({ count: 1 });
    expect(strapi.tables["api::notification.notification"]).toEqual([]);
  });

  it("returns relations only when populated (a missing populate is visible in tests)", async () => {
    const strapi = createStrapiStub({
      tables: {
        "plugin::users-permissions.user": [{ id: 7, username: "ada", department: { id: 10 } }],
      },
    });
    const query = strapi.db.query("plugin::users-permissions.user");
    expect(await query.findOne({ where: { id: 7 } })).toEqual({ id: 7, username: "ada" });
    expect(await query.findOne({ where: { id: 7 }, populate: { department: true } })).toEqual({
      id: 7,
      username: "ada",
      department: { id: 10 },
    });
    // A relation that is not set populates as null (to-one) or [] (to-many, from the schema).
    expect(
      await query.findOne({ where: { id: 7 }, populate: { manager: true, teams: true } }),
    ).toEqual({
      id: 7,
      username: "ada",
      manager: null,
      teams: [],
    });
  });

  it("records every call so a test can prove a path touched no data", async () => {
    const strapi = createStrapiStub();
    await strapi.db.query("api::poll.poll").findMany({ where: { id: 1 } });
    await strapi.documents("api::poll.poll").findMany();
    expect(strapi.calls.map(({ api, uid, method }) => `${api}:${uid}:${method}`)).toEqual([
      "db:api::poll.poll:findMany",
      "documents:api::poll.poll:findMany",
    ]);
  });
});

describe("strapi-stub documents(): draft & publish twins", () => {
  const ANNOUNCEMENT = "api::announcement.announcement";

  it("reads the draft & publish flags from the real schemas (department/team single-row, decision 05)", () => {
    const strapi = createStrapiStub();
    expect(strapi.hasDraftAndPublish(ANNOUNCEMENT)).toBe(true);
    expect(strapi.hasDraftAndPublish("api::wiki-page.wiki-page")).toBe(true);
    expect(strapi.hasDraftAndPublish("api::department.department")).toBe(false);
    expect(strapi.hasDraftAndPublish("api::team.team")).toBe(false);
    expect(strapi.hasDraftAndPublish("plugin::users-permissions.user")).toBe(false);
    expect(() => strapi.hasDraftAndPublish("api::nope.nope")).toThrow(/unknown content type/);
  });

  it("creates a draft row and a published twin with DIFFERENT ids and one documentId", async () => {
    const strapi = createStrapiStub();
    const created = await strapi
      .documents(ANNOUNCEMENT)
      .create({ data: { title: "Hi" }, status: "published" });
    const rows = strapi.tables[ANNOUNCEMENT];
    expect(rows).toHaveLength(2);
    const [draft, published] = rows;
    expect(draft.documentId).toBe(published.documentId);
    expect(draft.id).not.toBe(published.id);
    expect(draft.publishedAt).toBeNull();
    expect(published.publishedAt).not.toBeNull();
    expect(created.id).toBe(published.id);
    expect(created.documentId).toMatch(/^[a-z][a-z0-9]{23}$/);
  });

  it("defaults to the draft (Document Service), and publish recreates the published row with a new id", async () => {
    const strapi = createStrapiStub();
    const { documentId, draft, published } = strapi.seedDocument(
      ANNOUNCEMENT,
      { title: "v1" },
      { status: "published" },
    );
    const documents = strapi.documents(ANNOUNCEMENT);
    expect((await documents.findOne({ documentId }))?.id).toBe(draft?.id);
    expect((await documents.findOne({ documentId, status: "published" }))?.id).toBe(published?.id);

    await documents.update({ documentId, data: { title: "v2" } });
    expect((await documents.findOne({ documentId, status: "published" }))?.title).toBe("v1");
    const [republished] = (await documents.publish({ documentId })).entries;
    expect(republished.title).toBe("v2");
    expect(republished.id).not.toBe(published?.id);
    expect(strapi.tables[ANNOUNCEMENT].filter((row) => row.documentId === documentId)).toHaveLength(
      2,
    );
  });

  it("writes a payload-only draft for a published-only document (Strapi 5.55.1, FX38)", async () => {
    const strapi = createStrapiStub();
    const { documentId } = strapi.seedDocument(
      ANNOUNCEMENT,
      { title: "t", body: "b" },
      { status: "published" },
    );
    strapi.tables[ANNOUNCEMENT] = strapi.tables[ANNOUNCEMENT].filter(
      (row) => row.publishedAt !== null,
    );
    const draft = await strapi
      .documents(ANNOUNCEMENT)
      .update({ documentId, data: { title: "t2" } });
    expect(draft).toMatchObject({ title: "t2", publishedAt: null });
    expect(draft?.body).toBeUndefined();
  });

  it("keeps department and team single-row: one row, publishedAt set, status ignored", async () => {
    const strapi = createStrapiStub();
    const department = await strapi
      .documents("api::department.department")
      .create({ data: { name: "Eng" } });
    expect(strapi.tables["api::department.department"]).toHaveLength(1);
    expect(department.publishedAt).not.toBeNull();
    const documentId = String(department.documentId);
    const documents = strapi.documents("api::department.department");
    expect((await documents.findOne({ documentId, status: "draft" }))?.id).toBe(department.id);
    await documents.update({ documentId, data: { name: "Engineering" } });
    expect(strapi.tables["api::department.department"]).toEqual([
      expect.objectContaining({ id: department.id, name: "Engineering" }),
    ]);
  });

  it("filters, unpublishes and discards drafts", async () => {
    const strapi = createStrapiStub();
    const documents = strapi.documents(ANNOUNCEMENT);
    const a = strapi.seedDocument(ANNOUNCEMENT, { title: "a" }, { status: "published" });
    strapi.seedDocument(ANNOUNCEMENT, { title: "b" });
    expect((await documents.findMany({ status: "published" })).map((row) => row.title)).toEqual([
      "a",
    ]);
    expect(await documents.count({ filters: { title: { $in: ["a", "b"] } } })).toBe(2);

    await documents.update({ documentId: a.documentId, data: { title: "a-edit" } });
    const [restored] = (await documents.discardDraft({ documentId: a.documentId })).entries;
    expect(restored).toMatchObject({ title: "a", publishedAt: null });

    await documents.unpublish({ documentId: a.documentId });
    expect(await documents.findOne({ documentId: a.documentId, status: "published" })).toBeNull();
    expect((await documents.delete({ documentId: a.documentId })).entries).toHaveLength(1);
  });

  it("converts a Document Service sort and pages with start/limit", async () => {
    let second = 0;
    const strapi = createStrapiStub({
      now: () => new Date(Date.UTC(2026, 8, 28, 8, 0, second++)).toISOString(),
    });
    for (const title of ["b", "a", "c"]) strapi.seedDocument(ANNOUNCEMENT, { title });
    const documents = strapi.documents(ANNOUNCEMENT);
    const titles = async (params: DocumentParams) =>
      (await documents.findMany(params)).map((row) => row.title);

    expect(await titles({ sort: "createdAt:desc" })).toEqual(["c", "a", "b"]);
    expect(await titles({ sort: "createdAt" })).toEqual(["b", "a", "c"]);
    expect(await titles({ sort: { title: "DESC" } })).toEqual(["c", "b", "a"]);
    expect(await titles({ sort: ["title:asc"] })).toEqual(["a", "b", "c"]);
    expect(await titles({ sort: " title:desc , createdAt " })).toEqual(["c", "b", "a"]);
    expect(await titles({ sort: "title:desc", start: 1, limit: 1 })).toEqual(["b"]);
    expect(await titles({ sort: "title", limit: -1 })).toEqual(["a", "b", "c"]);
    expect((await documents.findFirst({ sort: "createdAt:desc" }))?.title).toBe("c");
    // The engine's count reads only the where.
    expect(await documents.count({ sort: "title", limit: 1 })).toBe(3);
  });

  it("throws on Document Service params and sorts it does not model", async () => {
    const strapi = createStrapiStub();
    strapi.seedDocument(ANNOUNCEMENT, { title: "a" });
    const documents = strapi.documents(ANNOUNCEMENT);
    const withKeys = (params: Record<string, unknown>) => params as DocumentParams;

    await expect(documents.findMany({ sort: "nope:desc" })).rejects.toThrow(/unknown column nope/);
    await expect(documents.findMany({ sort: "title:sideways" })).rejects.toThrow(/invalid/);
    await expect(documents.findMany({ sort: "author.username:asc" })).rejects.toThrow(
      /relation path author.username is not modelled/,
    );
    await expect(
      documents.findMany(withKeys({ sort: { author: { username: "asc" } } })),
    ).rejects.toThrow(/not modelled/);
    await expect(documents.findMany({ sort: "author" })).rejects.toThrow(
      /relation author is not modelled/,
    );
    await expect(documents.findMany({ limit: 1.5 })).rejects.toThrow(/limit 1.5/);
    await expect(documents.findMany({ start: -1 })).rejects.toThrow(/start -1/);
    for (const extra of [
      { locale: "de" },
      { pagination: { page: 1, pageSize: 10 } },
      { page: 2 },
      { publicationFilter: "never-published" },
    ]) {
      await expect(documents.findMany(withKeys(extra)), JSON.stringify(extra)).rejects.toThrow(
        /documents\(\)\.findMany does not model/,
      );
    }
    await expect(
      documents.update({ documentId: "x", data: { title: "b" }, sort: "title" }),
    ).rejects.toThrow(/documents\(\)\.update does not model sort/);
    // An undefined value counts as absent.
    expect(await documents.findMany(withKeys({ locale: undefined }))).toHaveLength(1);
  });

  it("mints documentIds in the shape Strapi 5 generates", () => {
    expect(stubDocumentId(1)).toMatch(/^[a-z][a-z0-9]{23}$/);
    expect(stubDocumentId(1)).not.toBe(stubDocumentId(2));
  });
});

describe("strapi-stub transactions, services and logs", () => {
  it("runs onCommit after the OUTERMOST transaction commits, nested calls join it", async () => {
    const strapi = createStrapiStub();
    const order: string[] = [];
    await strapi.db.transaction(async ({ onCommit }) => {
      onCommit(() => order.push("outer commit"));
      await strapi.db.transaction(async (inner) => {
        inner.onCommit(() => order.push("inner commit"));
        order.push("inner body");
      });
      order.push("outer body");
      expect(strapi.db.inTransaction()).toBe(true);
    });
    expect(order).toEqual(["inner body", "outer body", "outer commit", "inner commit"]);
    expect(strapi.db.inTransaction()).toBe(false);
  });

  it("runs onRollback (and no onCommit) when the transaction throws", async () => {
    const strapi = createStrapiStub();
    const order: string[] = [];
    await expect(
      strapi.db.transaction(async ({ onCommit, onRollback }) => {
        onCommit(() => order.push("commit"));
        onRollback(() => order.push("rollback"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(order).toEqual(["rollback"]);
  });

  it("serves only the services a test stubs", () => {
    const users = { fetch: () => null };
    const strapi = createStrapiStub({
      plugins: { "users-permissions": { user: users } },
      services: { "api::poll.poll": {} },
    });
    expect(strapi.plugin("users-permissions").service("user")).toBe(users);
    expect(strapi.service("api::poll.poll")).toEqual({});
    expect(() => strapi.plugin("upload").service("upload")).toThrow(/not stubbed/);
    expect(() => strapi.service("api::nope.nope")).toThrow(/not stubbed/);
  });

  it("exposes log spies and the request context", () => {
    const strapi = createStrapiStub({ requestContext: { state: { user: { id: 1 } } } });
    strapi.log.warn("careful");
    expect(strapi.log.warn).toHaveBeenCalledWith("careful");
    expect(strapi.requestContext.get()).toEqual({ state: { user: { id: 1 } } });
    expect(strapi.getModel("api::poll.poll")?.attributes.audience?.type).toBe("enumeration");
  });

  it("builds policy contexts the way createPolicyContext does (request shared, query a decoy)", () => {
    const decoy = { filters: "DECOY" };
    const ctx = policyContext(
      { id: 1, role: { type: "member" } },
      { query: { a: 1 }, params: { id: "3" }, decoy },
    );
    expect(ctx).toEqual({
      state: { user: { id: 1, role: { type: "member" } } },
      params: { id: "3" },
      request: { query: { a: 1 } },
      query: decoy,
    });
    expect(policyContext(undefined)).toEqual({ request: { query: {} } });
    expect(policyContext(null)).toEqual({ state: {}, request: { query: {} } });
  });
});
