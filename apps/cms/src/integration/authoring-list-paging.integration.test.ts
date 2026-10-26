import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { authoringApi, type AuthoringApi } from "./authoring.test.helper";
import { createTestStrapi, testEngines, type Caller, type TestStrapi } from "./harness.test.helper";
import { WIKI_PAGE, WIKI_SPACE, seedPage, seedSpace } from "./wiki.test.helper";

/**
 * The /manage list's light path (#170, v0.31) on SQLite and Postgres 16:
 * without a `status` filter a moderator's list reads the page's documents
 * only, and it must show exactly what the full path shows. The full path
 * still serves `status`, so the union of status=draft, published and
 * modified (every document has exactly one of them), in the list's order,
 * is the reference. Plus the version rule: a write committed between the
 * page's revisions read and its content read leaves newer content under
 * the older version, never the reverse.
 */

const ANNOUNCEMENT = "api::announcement.announcement";
const COURSE = "api::course.course";
const LESSON = "api::lesson.lesson";
const VERSION = "api::content-version.content-version";

type ListRow = { documentId: string; updatedAt: string | null; [key: string]: unknown };

/** The query engine's metadata and knex, which the harness types do not name. */
interface RawDb {
  metadata: { get(uid: string): { tableName: string } };
  connection(table: string): RawQuery;
}
interface RawQuery {
  where(columns: Record<string, unknown>): RawQuery;
  whereNull(column: string): RawQuery;
  update(data: Record<string, unknown>): Promise<unknown>;
}

/** The list's order (authoring-controller.ts newestDraftFirst): no updatedAt counts as 0. */
const newestDraftFirst = (a: ListRow, b: ListRow) => {
  const at = (row: ListRow) => (row.updatedAt === null ? 0 : Date.parse(row.updatedAt));
  const delta = at(b) - at(a);
  return delta !== 0 ? delta : a.documentId.localeCompare(b.documentId);
};

describe.each(testEngines())("the /manage list's light path on %s", (engine) => {
  let t: TestStrapi;
  let api: AuthoringApi;
  let serial = 0;
  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    api = authoringApi(t);
  });
  afterAll(async () => {
    await t?.stop();
  });

  const unique = (prefix: string) => `${prefix} ${++serial}`;

  /** Every page of a list, in order; also checks the page size and the total. */
  async function everyPage(caller: Caller, plural: string, query = ""): Promise<ListRow[]> {
    const out: ListRow[] = [];
    for (let page = 1; ; page++) {
      const res = await api.list<ListRow>(
        caller,
        plural,
        [query, `page=${page}`].filter(Boolean).join("&"),
      );
      expect(res.status, res.text).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(25);
      out.push(...res.body.data);
      if (page >= res.body.meta.pagination.pageCount) {
        expect(out).toHaveLength(res.body.meta.pagination.total);
        return out;
      }
    }
  }

  /** The full path's documents for `query`: the three status lists, merged in the list's order. */
  async function fullPath(caller: Caller, plural: string, query = ""): Promise<ListRow[]> {
    const rows: ListRow[] = [];
    for (const status of ["draft", "published", "modified"]) {
      rows.push(
        ...(await everyPage(caller, plural, [query, `status=${status}`].filter(Boolean).join("&"))),
      );
    }
    return rows.sort(newestDraftFirst);
  }

  /** The table of `uid` in knex, for raw writes. */
  const tableOf = (uid: string) => {
    const db = t.strapi.db as unknown as RawDb;
    return db.connection(db.metadata.get(uid).tableName);
  };

  /** Sets the draft row's updated_at directly (the Document Service always stamps "now"). */
  async function stampDraft(uid: string, documentId: string, at: string | null) {
    await tableOf(uid)
      .where({ document_id: documentId })
      .whereNull("published_at")
      .update({ updated_at: at === null ? null : new Date(at) });
  }

  async function seedAnnouncement(
    state: "draft" | "published" | "modified",
    data: Record<string, unknown> = {},
  ): Promise<string> {
    const documents = t.strapi.documents(ANNOUNCEMENT);
    const created = (await documents.create({
      data: { title: unique("Paging"), ...data },
      status: state === "draft" ? "draft" : "published",
    })) as { documentId: string };
    if (state === "modified") {
      await documents.update({
        documentId: created.documentId,
        data: { title: unique("Paging edited") },
      });
    }
    return created.documentId;
  }

  it("announcements: pages 1, 2 and past the end, owner, q and equal updatedAt match the full path", async () => {
    const engineering = t.fixtures.departments.engineering.documentId;
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await seedAnnouncement("draft"));
    for (let i = 0; i < 10; i++) ids.push(await seedAnnouncement("published"));
    for (let i = 0; i < 8; i++) ids.push(await seedAnnouncement("modified"));
    for (let i = 0; i < 4; i++) {
      ids.push(
        await seedAnnouncement(i % 2 ? "draft" : "modified", { ownerDepartment: engineering }),
      );
    }
    ids.push(await seedAnnouncement("draft", { title: unique("Special paging") }));
    // Four drafts with the same instant: documentId decides.
    for (const documentId of ids.slice(3, 7)) {
      await stampDraft(ANNOUNCEMENT, documentId, "2026-10-01T08:00:00.000Z");
    }
    // A draft without updatedAt (a raw import): last, as 0.
    await stampDraft(ANNOUNCEMENT, ids[0], null);

    const light = await everyPage("editor", "announcements");
    expect(light.length).toBeGreaterThan(25);
    expect(light).toEqual(await fullPath("editor", "announcements"));
    expect(light[light.length - 1]).toMatchObject({ documentId: ids[0], updatedAt: null });
    const same = light.filter((row) => row.updatedAt === "2026-10-01T08:00:00.000Z");
    expect(same.map((row) => row.documentId)).toEqual(
      ids.slice(3, 7).sort((a, b) => a.localeCompare(b)),
    );

    for (const query of ["owner=department", "owner=moderators", "q=special%20PAGING"]) {
      expect(await everyPage("editor", "announcements", query), query).toEqual(
        await fullPath("editor", "announcements", query),
      );
    }
    expect(
      (await everyPage("editor", "announcements", "owner=department")).map((r) => r.documentId),
    ).toEqual(expect.arrayContaining(ids.slice(30, 34)));

    const past = await api.list<ListRow>("editor", "announcements", "page=99");
    expect(past.status).toBe(200);
    expect(past.body.data).toEqual([]);
    expect(past.body.meta.pagination.total).toBe(light.length);
  });

  it("wiki pages and spaces: a draft moved to another space keeps its published twin; page counts as before", async () => {
    const first = await seedSpace(t, { name: unique("Paging space") });
    const second = await seedSpace(t, { name: unique("Paging space") });
    for (let i = 0; i < 3; i++) await seedPage(t, { space: first.documentId });
    for (let i = 0; i < 2; i++) await seedPage(t, { space: second.documentId }, "draft");
    const moved = await seedPage(t, { space: first.documentId });
    await t.strapi.documents(WIKI_PAGE).update({
      documentId: moved.documentId,
      data: { space: second.documentId },
    });

    for (const space of [first, second]) {
      const query = `space=${space.documentId}`;
      expect(await everyPage("editor", "wiki-pages", query)).toEqual(
        await fullPath("editor", "wiki-pages", query),
      );
    }
    const inSecond = await everyPage("editor", "wiki-pages", `space=${second.documentId}`);
    expect(inSecond.find((row) => row.documentId === moved.documentId)).toMatchObject({
      status: "modified",
    });
    expect(
      (await everyPage("editor", "wiki-pages", `space=${first.documentId}`)).map(
        (row) => row.documentId,
      ),
    ).not.toContain(moved.documentId);

    // Spaces have no status filter: the page counts span both stored states.
    const spaces = await everyPage("editor", "wiki-spaces");
    expect(spaces.find((row) => row.documentId === first.documentId)).toMatchObject({
      pageCount: 4,
    });
    expect(spaces.find((row) => row.documentId === second.documentId)).toMatchObject({
      pageCount: 3,
    });
    expect(await t.strapi.db.query(WIKI_SPACE).count({})).toBeGreaterThanOrEqual(2);
  });

  it("lessons: the course filter matches the full path", async () => {
    const course = async () =>
      (await t.strapi.documents(COURSE).create({
        data: { title: unique("Paging course"), slug: `paging-course-${++serial}` },
        status: "published",
      })) as { documentId: string };
    const [a, b] = [await course(), await course()];
    for (const [parent, status] of [
      [a, "draft"],
      [a, "published"],
      [a, "draft"],
      [b, "draft"],
    ] as const) {
      await t.strapi.documents(LESSON).create({
        data: { title: unique("Paging lesson"), course: parent.documentId, order: 1 },
        status,
      });
    }
    for (const parent of [a, b]) {
      const query = `course=${parent.documentId}`;
      const light = await everyPage("editor", "lessons", query);
      expect(light).toHaveLength(parent === a ? 3 : 1);
      expect(light).toEqual(await fullPath("editor", "lessons", query));
    }
  });

  it("a write committed between the page's revisions and its rows: newer content, older version", async () => {
    const created = await api.create(
      "editor",
      "announcements",
      { title: "Interleaved old" },
      "draft",
    );
    expect(created.status, created.text).toBe(201);
    const { documentId, version } = created.body.data;
    const db = t.strapi.db;
    const query = db.query.bind(db);
    let armed = true;
    const spy = vi.spyOn(db, "query").mockImplementation(((uid: string) => {
      const target = query(uid);
      if (uid !== VERSION) return target;
      return new Proxy(target, {
        get(object, key, receiver) {
          if (key !== "findMany") return Reflect.get(object, key, receiver);
          return async (params: unknown) => {
            const rows = await object.findMany(params as never);
            if (armed) {
              armed = false;
              // The other write, committed: new content and the next revision.
              await tableOf(ANNOUNCEMENT)
                .where({ document_id: documentId })
                .update({ title: "Interleaved new" });
              await tableOf(VERSION)
                .where({ target_document_id: documentId })
                .update({ revision: Number(version) + 1 });
            }
            return rows;
          };
        },
      });
    }) as typeof db.query);
    try {
      const list = await api.list<ListRow & { label: string; version: string }>(
        "editor",
        "announcements",
      );
      expect(list.status, list.text).toBe(200);
      expect(armed).toBe(false);
      expect(list.body.data.find((row) => row.documentId === documentId)).toMatchObject({
        label: "Interleaved new",
        version,
      });
    } finally {
      spy.mockRestore();
    }
    const after = await api.list<ListRow & { label: string; version: string }>(
      "editor",
      "announcements",
    );
    expect(after.body.data.find((row) => row.documentId === documentId)).toMatchObject({
      label: "Interleaved new",
      version: String(Number(version) + 1),
    });
  });
});
