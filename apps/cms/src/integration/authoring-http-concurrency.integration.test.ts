import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_ENV, contentManager, type ContentManager } from "./admin-api.test.helper";
import { authoringApi, storedRevision, type AuthoringApi } from "./authoring.test.helper";
import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";

/**
 * Optimistic concurrency over HTTP (deep-dive decision 06 §G; batch 15
 * lane 15A) on SQLite and Postgres 16: the authoring routes need
 * `If-Match: "<revision>"` (428 without it), answer a stale one with 412 and
 * `details.current`, and three writers with one token end in exactly one
 * 200. Every transition advances the revision, from every source: a
 * publish, an unpublish, a discard, a scheduler run and a Content Manager
 * save each make an old token answer 412, so a web form never overwrites a
 * change it did not see.
 *
 * A read never hands out a version newer than the rows it shows (Codex
 * review of 15A, finding 2): with a write committed between the list's
 * statements, its token answers 412 to a publish and a delete; the form
 * (`editable`) reads its version first the same way.
 */
const A = "api::announcement.announcement";
const P = "announcements";
const QL = "api::quick-link.quick-link";
const QP = "quick-links";

interface Scheduler {
  runScheduledPublishing(strapi: unknown, now?: Date): Promise<unknown>;
}

describe.each(testEngines())("authoring: HTTP concurrency on %s", (engine) => {
  let t: TestStrapi;
  let api: AuthoringApi;
  let panel: ContentManager;
  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: ADMIN_ENV });
    api = authoringApi(t);
    panel = await contentManager(t);
  });
  afterAll(async () => {
    await t?.stop();
  });

  const draft = async (title: string, status: "draft" | "published" = "draft") => {
    const res = await api.create("editor", P, { title }, status);
    expect(res.status, res.text).toBe(201);
    return { documentId: res.body.data.documentId, version: res.body.data.version };
  };

  it("428 without If-Match or with a malformed one, 412 with details.current for a stale one", async () => {
    const item = await draft("Tokens");
    expect(
      (await api.update("editor", P, item.documentId, { title: "x" }, { version: null })).status,
    ).toBe(428);
    const malformed = await t.api("editor", `/api/announcements/${item.documentId}?status=draft`, {
      method: "PUT",
      headers: { "If-Match": "W/abc" },
      json: { data: { title: "x" } },
    });
    expect(malformed.status).toBe(428);
    const stale = await api.update("editor", P, item.documentId, { title: "x" }, { version: 7 });
    expect(stale.status).toBe(412);
    expect(stale.body.error).toMatchObject({
      name: "PreconditionFailedError",
      details: { current: Number(item.version) },
    });
    const bare = await t.api<{ data: { version: string } }>(
      "editor",
      `/api/announcements/${item.documentId}?status=draft`,
      { method: "PUT", headers: { "If-Match": item.version }, json: { data: { title: "bare" } } },
    );
    expect(bare.status, bare.text).toBe(200);
  });

  it("three writers with one token: one 200, two 412", async () => {
    const item = await draft("Three writers");
    const answers = await Promise.all(
      ["one", "two", "three"].map((title) =>
        api.update("editor", P, item.documentId, { title }, { version: item.version }),
      ),
    );
    const statuses = answers.map((answer) => answer.status).sort();
    expect(statuses).toEqual([200, 412, 412]);
    const winner = answers.find((answer) => answer.status === 200);
    expect(await storedRevision(t, A, item.documentId)).toBe(Number(winner?.body.data.version));
    for (const loser of answers.filter((answer) => answer.status === 412)) {
      expect(loser.body.error?.details?.current).toBe(Number(winner?.body.data.version));
    }
  });

  it("an old token answers 412 after a publish, an unpublish and a discard", async () => {
    const item = await draft("Transitions");
    const publish = await api.action("editor", P, item.documentId, "publish", item.version);
    expect(publish.status).toBe(200);
    expect(
      (await api.update("editor", P, item.documentId, { title: "x" }, { version: item.version }))
        .status,
    ).toBe(412);
    const unpublish = await api.action(
      "editor",
      P,
      item.documentId,
      "unpublish",
      publish.body.data.version,
    );
    expect(unpublish.status).toBe(200);
    // The case of Rationale 6: a stale Save and publish must not republish.
    const republish = await api.update(
      "editor",
      P,
      item.documentId,
      { title: "x" },
      { status: "published", version: publish.body.data.version },
    );
    expect(republish.status).toBe(412);
    expect((await t.api("member", `/api/announcements/${item.documentId}`)).status).toBe(404);

    const again = await api.action(
      "editor",
      P,
      item.documentId,
      "publish",
      unpublish.body.data.version,
    );
    const edit = await api.update(
      "editor",
      P,
      item.documentId,
      { title: "Edited" },
      { version: again.body.data.version },
    );
    const discard = await api.action(
      "editor",
      P,
      item.documentId,
      "discard-draft",
      edit.body.data.version,
    );
    expect(discard.status).toBe(200);
    expect(Number(discard.body.data.version)).toBe(Number(edit.body.data.version) + 1);
    expect(
      (
        await api.update(
          "editor",
          P,
          item.documentId,
          { title: "x" },
          { version: edit.body.data.version },
        )
      ).status,
    ).toBe(412);
  });

  it("an old token answers 412 after a Content Manager save, and the form shows the panel's change", async () => {
    const item = await draft("Panel race");
    const save = await panel.update(A, item.documentId, { title: "Panel edit" });
    expect(save.status, save.text).toBe(200);
    const stale = await api.update(
      "editor",
      P,
      item.documentId,
      { title: "Web edit" },
      { version: item.version },
    );
    expect(stale.status).toBe(412);
    const form = await api.editable<{ title: string; version: string }>(
      "editor",
      P,
      item.documentId,
    );
    expect(form.body.data.title).toBe("Panel edit");
    expect(Number(form.body.data.version)).toBe(stale.body.error?.details?.current);
    // "Overwrite" resends with the returned version.
    const overwrite = await api.update(
      "editor",
      P,
      item.documentId,
      { title: "Web edit" },
      { version: stale.body.error?.details?.current },
    );
    expect(overwrite.status).toBe(200);
  });

  it("an old token answers 412 after a scheduler run", async () => {
    const item = await draft("Scheduled");
    const publishAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const schedule = await api.update(
      "editor",
      P,
      item.documentId,
      { publishAt },
      { version: item.version },
    );
    expect(schedule.status, schedule.text).toBe(200);
    expect(schedule.body.data.publishAt).toBe(publishAt);
    const scheduler = t.requireBuilt<Scheduler>("src/cron/scheduled-publish");
    await scheduler.runScheduledPublishing(t.strapi, new Date(Date.now() + 10 * 60_000));
    const stale = await api.update(
      "editor",
      P,
      item.documentId,
      { title: "x" },
      { version: schedule.body.data.version },
    );
    expect(stale.status).toBe(412);
    const form = await api.editable<{ status: string; publishAt: string | null }>(
      "editor",
      P,
      item.documentId,
    );
    expect(form.body.data).toMatchObject({ status: "published", publishAt: null });
  });

  it("a refused write moves nothing: a 400, 412 or 428 leaves the revision and the rows", async () => {
    const item = await draft("Untouched");
    const before = await storedRevision(t, A, item.documentId);
    await api.update("editor", P, item.documentId, { pinned: "yes" }, { version: item.version });
    await api.update("editor", P, item.documentId, { title: "x" }, { version: 99 });
    await api.update("editor", P, item.documentId, { title: "x" }, { version: null });
    expect(await storedRevision(t, A, item.documentId)).toBe(before);
    const [row] = await t.strapi.db.query(A).findMany({ where: { documentId: item.documentId } });
    expect(row.title).toBe("Untouched");
  });

  describe("a write committed between a read's statements (Codex review of 15A, finding 2)", () => {
    type Params = { where?: Record<string, unknown> } | undefined;
    /**
     * Commits `write` right after the next quick-link `findMany` that
     * `when` matches has read its rows, before the reader goes on (the
     * reads of the list and of the form are separate statements).
     */
    const commitAfterNextRead = (
      when: (params: Params) => boolean,
      write: () => Promise<unknown>,
    ) => {
      const repository = t.strapi.db.query(QL) as unknown as {
        findMany(params: Params): Promise<unknown>;
      };
      const original = repository.findMany;
      let armed = true;
      repository.findMany = async function (this: unknown, params: Params) {
        const rows = await original.call(this, params);
        if (armed && when(params)) {
          armed = false;
          await write();
        }
        return rows;
      };
      return () => {
        repository.findMany = original;
      };
    };
    const link = async (label: string) => {
      const res = await api.create("editor", QP, { label, url: "/race" }, "draft");
      expect(res.status, res.text).toBe(201);
      return { documentId: res.body.data.documentId, version: res.body.data.version };
    };
    const changeUnseen = (documentId: string, label: string) => () =>
      t.strapi.documents(QL).update({ documentId, data: { label } });

    it("the list's version is never newer than its rows: that token cannot publish or delete the unseen change", async () => {
      const item = await link("Listed race");
      const restore = commitAfterNextRead(
        // The full path's draft read (no documentId in its where); `status`
        // keeps the list on that path (the light path's version rule:
        // authoring-list-paging.integration.test.ts).
        (params) => params?.where !== undefined && !("documentId" in params.where),
        changeUnseen(item.documentId, "Listed race, changed unseen"),
      );
      let list: Awaited<
        ReturnType<typeof api.list<{ documentId: string; label: string; version: string }>>
      >;
      try {
        list = await api.list<{ documentId: string; label: string; version: string }>(
          "editor",
          QP,
          "status=draft&q=listed%20race",
        );
      } finally {
        restore();
      }
      expect(list.status, list.text).toBe(200);
      expect(await storedRevision(t, QL, item.documentId)).toBe(Number(item.version) + 1);
      const row = list.body.data.find((entry) => entry.documentId === item.documentId);
      expect(row?.label).toBe("Listed race");
      expect(row?.version).toBe(item.version);
      const publish = await api.action("editor", QP, item.documentId, "publish", row?.version);
      expect(publish.status, publish.text).toBe(412);
      const remove = await api.remove("editor", QP, item.documentId, row?.version);
      expect(remove.status, remove.text).toBe(412);
      const rows = await t.strapi.db.query(QL).findMany({ where: { documentId: item.documentId } });
      expect(rows.map((entry) => entry.publishedAt)).toEqual([null]);
    });

    it("the form reads its version before its rows: a change committed after them answers 412", async () => {
      const item = await link("Form race");
      const restore = commitAfterNextRead(
        (params) => params?.where?.documentId === item.documentId,
        changeUnseen(item.documentId, "Form race, changed unseen"),
      );
      let form: Awaited<ReturnType<typeof api.editable<{ label: string }>>>;
      try {
        form = await api.editable<{ label: string }>("editor", QP, item.documentId);
      } finally {
        restore();
      }
      expect(form.status, form.text).toBe(200);
      expect(await storedRevision(t, QL, item.documentId)).toBe(Number(item.version) + 1);
      expect(form.body.data).toMatchObject({ label: "Form race", version: item.version });
      const remove = await api.remove("editor", QP, item.documentId, form.body.data.version);
      expect(remove.status, remove.text).toBe(412);
    });
  });
});
