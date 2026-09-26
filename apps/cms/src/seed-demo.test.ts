/**
 * Demo seed (FX38): draft & publish content goes through the Document
 * Service (create + publish = a draft and a published row per document, with
 * relations as documentIds); everything else stays single-row db.query
 * writes. The fake records every write; the set of draft & publish types is
 * read from the schemas, so a type that gains draft & publish is covered.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { seedDemoData, type SeedDemoHost, type SeedRow } from "./seed-demo";

function draftAndPublishUids(): string[] {
  const apiDir = join(__dirname, "api");
  const uids: string[] = [];
  for (const api of readdirSync(apiDir)) {
    const typesDir = join(apiDir, api, "content-types");
    if (!existsSync(typesDir)) continue;
    for (const name of readdirSync(typesDir)) {
      const file = join(typesDir, name, "schema.json");
      if (!existsSync(file)) continue;
      const schema = JSON.parse(readFileSync(file, "utf8")) as {
        options?: { draftAndPublish?: boolean };
      };
      if (schema.options?.draftAndPublish === true) uids.push(`api::${api}.${name}`);
    }
  }
  return uids.sort();
}

type Data = Record<string, unknown>;

interface Write {
  uid: string;
  data: Data;
  row: SeedRow;
}

function fakeStrapi(existing: { departments?: number; users?: number } = {}) {
  let nextId = 1;
  const row = (uid: string): SeedRow => {
    const id = nextId++;
    return { id, documentId: `${uid.split(".").pop()}-doc-${id}` };
  };
  const writes = {
    dbCreate: [] as Write[],
    dbUpdate: [] as Array<{ uid: string; where: Data; data: Data }>,
    documentsCreate: [] as Array<Write & { status: string }>,
    usersAdd: [] as Write[],
    queryBuilderUpdate: [] as Array<{ uid: string; data: Data; where: Data }>,
  };
  const logs: string[] = [];
  const order: string[] = [];

  const strapi: SeedDemoHost = {
    db: {
      query: (uid) => ({
        count: async () =>
          uid === "api::department.department"
            ? (existing.departments ?? 0)
            : uid === "plugin::users-permissions.user"
              ? (existing.users ?? 0)
              : 0,
        findOne: async () => row(uid),
        create: async ({ data }) => {
          const created = row(uid);
          writes.dbCreate.push({ uid, data, row: created });
          order.push(uid);
          return created;
        },
        update: async ({ where, data }) => {
          writes.dbUpdate.push({ uid, where, data });
          return {};
        },
      }),
      queryBuilder: (uid) => ({
        update: (data) => ({
          where: (where) => ({
            execute: async () => {
              writes.queryBuilderUpdate.push({ uid, data, where });
              return 1;
            },
          }),
        }),
      }),
    },
    documents: (uid) => ({
      create: async ({ data, status }) => {
        const created = row(uid);
        writes.documentsCreate.push({ uid, data, status, row: created });
        order.push(uid);
        return created;
      },
    }),
    plugin: () => ({
      service: () => ({
        add: async (values) => {
          const created = row("plugin::users-permissions.user");
          writes.usersAdd.push({
            uid: "plugin::users-permissions.user",
            data: values,
            row: created,
          });
          return created;
        },
      }),
    }),
    log: { info: (message) => logs.push(message) },
  };
  return { strapi, writes, logs, order };
}

const DP_UIDS = draftAndPublishUids();

describe("seedDemoData", () => {
  const previous = process.env.SEED_DEMO_DATA;
  beforeEach(() => {
    process.env.SEED_DEMO_DATA = "1";
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.SEED_DEMO_DATA;
    else process.env.SEED_DEMO_DATA = previous;
  });

  it("does nothing without SEED_DEMO_DATA=1", async () => {
    process.env.SEED_DEMO_DATA = "true";
    const { strapi, writes, logs } = fakeStrapi();
    await seedDemoData(strapi);
    expect(writes.dbCreate).toEqual([]);
    expect(writes.documentsCreate).toEqual([]);
    expect(logs).toEqual([]);
  });

  it.each([
    ["departments", { departments: 1 }],
    ["users", { users: 3 }],
  ])("skips a database that already has %s", async (_what, existing) => {
    const { strapi, writes, logs } = fakeStrapi(existing);
    await seedDemoData(strapi);
    expect(logs).toEqual(["[seed-demo] data already exists, skipping"]);
    expect(writes.dbCreate).toEqual([]);
    expect(writes.documentsCreate).toEqual([]);
    expect(writes.usersAdd).toEqual([]);
  });

  it("writes every draft & publish type through the Document Service, published", async () => {
    const { strapi, writes } = fakeStrapi();
    await seedDemoData(strapi);
    expect(DP_UIDS.length).toBeGreaterThanOrEqual(10);
    expect(
      writes.dbCreate.filter((write) => DP_UIDS.includes(write.uid)).map((write) => write.uid),
    ).toEqual([]);
    expect(
      writes.dbUpdate.filter((write) => DP_UIDS.includes(write.uid)).map((write) => write.uid),
    ).toEqual([]);
    expect(new Set(writes.documentsCreate.map((write) => write.status))).toEqual(
      new Set(["published"]),
    );
    const perType: Record<string, number> = {};
    for (const write of writes.documentsCreate) perType[write.uid] = (perType[write.uid] ?? 0) + 1;
    expect(perType).toEqual({
      "api::announcement.announcement": 5,
      "api::event.event": 6,
      "api::wiki-space.wiki-space": 3,
      "api::wiki-page.wiki-page": 5,
      "api::poll.poll": 3,
      "api::document.document": 6,
    });
    for (const write of writes.documentsCreate)
      expect(write.data).not.toHaveProperty("publishedAt");
  });

  it("passes relations to the Document Service as documentIds", async () => {
    const { strapi, writes } = fakeStrapi();
    await seedDemoData(strapi);
    const users = new Map(writes.usersAdd.map((write) => [write.data.username, write.row]));
    const departments = new Map(
      writes.dbCreate
        .filter((write) => write.uid === "api::department.department")
        .map((write) => [write.data.name, write.row]),
    );
    const spaces = writes.documentsCreate.filter(
      (write) => write.uid === "api::wiki-space.wiki-space",
    );
    const relationKeys = ["author", "organizer", "uploadedBy", "department", "space"];
    for (const write of writes.documentsCreate) {
      for (const key of relationKeys) {
        if (key in write.data) expect(typeof write.data[key], `${write.uid}.${key}`).toBe("string");
      }
    }
    const welcome = writes.documentsCreate.find(
      (write) => write.data.title === "Welcome to Sinnlos Intranet!",
    );
    expect(welcome?.data.author).toBe(users.get("dana.patel")?.documentId);
    const retro = writes.documentsCreate.find((write) =>
      String(write.data.title).startsWith("Engineering: Sprint Retro"),
    );
    expect(retro?.data.department).toBe(departments.get("Engineering")?.documentId);
    const reviews = writes.documentsCreate.find(
      (write) => write.data.slug === "code-review-guidelines",
    );
    expect(reviews?.data.space).toBe(
      spaces.find((write) => write.data.slug === "engineering")?.row.documentId,
    );
    expect(spaces.find((write) => write.data.slug === "people-culture")?.data.department).toBe(
      departments.get("Human Resources")?.documentId,
    );
  });

  it("creates the wiki spaces before the pages that link them", async () => {
    const { strapi, order } = fakeStrapi();
    await seedDemoData(strapi);
    const lastSpace = order.lastIndexOf("api::wiki-space.wiki-space");
    const firstPage = order.indexOf("api::wiki-page.wiki-page");
    expect(lastSpace).toBeGreaterThanOrEqual(0);
    expect(firstPage).toBeGreaterThan(lastSpace);
  });

  it("keeps departments and teams single live rows (no draft & publish)", async () => {
    const { strapi, writes } = fakeStrapi();
    await seedDemoData(strapi);
    const org = writes.dbCreate.filter((write) =>
      ["api::department.department", "api::team.team"].includes(write.uid),
    );
    expect(org).toHaveLength(5 + 8);
    for (const write of org) expect(write.data.publishedAt).toBeInstanceOf(Date);
  });

  it("backdates the published announcements by 0, 2, 4, 6 and 8 days without lifecycles", async () => {
    const { strapi, writes } = fakeStrapi();
    const now = Date.now();
    await seedDemoData(strapi);
    const announcements = writes.documentsCreate.filter(
      (write) => write.uid === "api::announcement.announcement",
    );
    expect(writes.queryBuilderUpdate.map((update) => update.where)).toEqual(
      announcements.map((write) => ({ id: write.row.id })),
    );
    // `|| 0` folds a -0 from rounding a few milliseconds.
    const days = writes.queryBuilderUpdate.map(
      (update) => Math.round((now - (update.data.publishedAt as Date).getTime()) / 86_400_000) || 0,
    );
    expect(days).toEqual([0, 2, 4, 6, 8]);
    expect(new Set(writes.queryBuilderUpdate.map((update) => update.uid))).toEqual(
      new Set(["api::announcement.announcement"]),
    );
  });

  it("anchors comments and reactions to the announcements' documentIds and votes to the published poll rows", async () => {
    const { strapi, writes } = fakeStrapi();
    await seedDemoData(strapi);
    const announcementDocs = writes.documentsCreate
      .filter((write) => write.uid === "api::announcement.announcement")
      .map((write) => write.row.documentId);
    const anchored = writes.dbCreate.filter((write) =>
      ["api::comment.comment", "api::reaction.reaction"].includes(write.uid),
    );
    expect(anchored).toHaveLength(5 + 9);
    for (const write of anchored) expect(announcementDocs).toContain(write.data.targetDocumentId);

    const polls = writes.documentsCreate
      .filter((write) => write.uid === "api::poll.poll")
      .map((write) => write.row.id);
    const votes = writes.dbCreate.filter((write) => write.uid === "api::poll-vote.poll-vote");
    expect(votes.filter((write) => write.data.poll === polls[0])).toHaveLength(7);
    expect(votes.filter((write) => write.data.poll === polls[1])).toHaveLength(5);
    for (const write of votes) expect(typeof write.data.voter).toBe("number");
  });

  it("never logs the demo password", async () => {
    const { strapi, writes, logs } = fakeStrapi();
    await seedDemoData(strapi);
    expect(writes.usersAdd).toHaveLength(10);
    expect(logs.join("\n")).not.toContain(String(writes.usersAdd[0].data.password));
    expect(logs[logs.length - 1]).toMatch(
      /^\[seed-demo\] done — 10 users, 5 departments, 8 teams, 5 announcements, 6 events/,
    );
  });
});
