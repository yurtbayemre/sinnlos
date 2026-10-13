import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_ENV, contentManager } from "./admin-api.test.helper";
import { storedRevision } from "./authoring.test.helper";
import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";
import {
  WIKI_PAGE,
  WIKI_SPACE,
  rowsOf,
  seedPage,
  seedSpace,
  wikiApi,
  type WikiApi,
} from "./wiki.test.helper";

/**
 * Wiki spaces on the v2 write model (deep-dive decision 06 §J1, §B3, §B4;
 * batch 16 lane 16B items 0 and 2, the port gate) on SQLite and Postgres
 * 16: global::can-author with the moderator rule, always published, the
 * slug derived, the visibility with its target, `If-Match` on every change,
 * and a space with pages neither deleted (the content API) nor unpublished
 * (the admin panel): the wiki checks answer `_form: spaceNotEmpty`.
 */

describe.each(testEngines())("authoring wiki spaces on %s", (engine) => {
  let t: TestStrapi;
  let wiki: WikiApi;
  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: ADMIN_ENV });
    wiki = wikiApi(t);
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("a moderator creates a role space: published at once, the slug derived, the roles as types", async () => {
    const res = await wiki.createSpace("editor", {
      name: "IT Members Space",
      icon: "BookOpen",
      description: "For members",
      visibility: "role",
      allowedRoles: ["member"],
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body.data).toMatchObject({
      status: "published",
      slug: expect.stringMatching(/^it-members-space-[0-9a-f]{8}$/),
    });
    expect(res.headers.get("etag")).toBe(`"${res.body.data.version}"`);
    const form = await wiki.editable<Record<string, unknown>>(
      "editor",
      "wiki-spaces",
      res.body.data.documentId,
    );
    expect(form.status).toBe(200);
    expect(form.body.data).toMatchObject({
      roleClass: "moderator",
      name: "IT Members Space",
      icon: "BookOpen",
      visibility: "role",
      allowedRoles: ["member"],
      pageCount: 0,
      needsRetarget: false,
      authorName: null,
    });
    // Readers: the member reads it, the team lead does not (role visibility).
    const read = async (role: "member" | "team_lead") =>
      (
        await t.api<{ data: unknown[] }>(
          role,
          `/api/wiki-spaces?filters[slug][$eq]=${res.body.data.slug}`,
        )
      ).body.data.length;
    expect(await read("member")).toBe(1);
    expect(await read("team_lead")).toBe(0);
  });

  it("refuses a visibility without its target, a client slug and the inverse pages", async () => {
    const noTarget = await wiki.createSpace("admin_role", {
      name: "IT No Target",
      visibility: "department",
    });
    expect(noTarget.status).toBe(400);
    expect(noTarget.body.error?.details).toEqual({
      keys: ["department"],
      codes: { department: "visibilityTarget" },
    });
    const keys = await wiki.createSpace("admin_role", { name: "IT Keys", slug: "x", pages: [] });
    expect(keys.status).toBe(400);
    expect(keys.body.error?.details).toEqual({ keys: ["pages", "slug"] });
    const draft = await wiki.createSpace("editor", { name: "IT Draft" }, "?status=draft");
    expect(draft.status).toBe(400);
    expect(draft.body.error?.details).toEqual({ keys: ["status"], codes: { status: "invalid" } });
  });

  it("updates with If-Match: 428 without, 412 stale, 200 with the version; re-targets by department", async () => {
    const created = await wiki.createSpace("editor", { name: "IT Retarget" });
    const { documentId, version } = created.body.data;
    const missing = await wiki.updateSpace("editor", documentId, { description: "x" });
    expect(missing.status).toBe(428);
    const ok = await wiki.updateSpace(
      "editor",
      documentId,
      { visibility: "department", department: t.fixtures.departments.sales.documentId },
      version,
    );
    expect(ok.status, ok.text).toBe(200);
    expect(Number(ok.body.data.version)).toBe(Number(version) + 1);
    const stale = await wiki.updateSpace("editor", documentId, { description: "y" }, version);
    expect(stale.status).toBe(412);
    expect(stale.body.error?.details).toEqual({ current: Number(ok.body.data.version) });
    // Every row carries the change (always published).
    for (const row of await rowsOf(t, WIKI_SPACE, documentId)) {
      expect(row.visibility).toBe("department");
    }
  });

  it("is moderators-only: a department head and a member get 403 on create, update and the list", async () => {
    const space = await seedSpace(t);
    const version = await storedRevision(t, WIKI_SPACE, space.documentId);
    for (const role of ["department_head", "team_lead", "member", "guest"] as const) {
      expect((await wiki.createSpace(role, { name: `IT ${role}` })).status, role).toBe(403);
      expect(
        (await wiki.updateSpace(role, space.documentId, { name: "x" }, version)).status,
        role,
      ).toBe(403);
      expect((await wiki.list(role, "wiki-spaces")).status, role).toBe(403);
      expect((await wiki.editable(role, "wiki-spaces", space.documentId)).status, role).toBe(403);
    }
    const list = await wiki.list<{ documentId: string; pageCount: number }>(
      "editor",
      "wiki-spaces",
    );
    expect(list.status).toBe(200);
    expect(list.body.data.map((row) => row.documentId)).toContain(space.documentId);
  });

  it("deletes an empty space (If-Match); a space with pages answers spaceNotEmpty and keeps them", async () => {
    const space = await seedSpace(t);
    const page = await seedPage(t, { space: space.documentId });
    const version = await storedRevision(t, WIKI_SPACE, space.documentId);
    const refused = await wiki.deleteSpace("editor", space.documentId, version);
    expect(refused.status).toBe(400);
    expect(refused.body.error?.details).toEqual({
      keys: ["_form"],
      codes: { _form: "spaceNotEmpty" },
    });
    expect((await rowsOf(t, WIKI_SPACE, space.documentId)).length).toBe(2);
    const list = await wiki.list<{ documentId: string; pageCount: number }>(
      "editor",
      "wiki-spaces",
    );
    expect(list.body.data.find((row) => row.documentId === space.documentId)?.pageCount).toBe(1);

    await t.strapi.documents(WIKI_PAGE).delete({ documentId: page.documentId });
    const missing = await wiki.deleteSpace("editor", space.documentId);
    expect(missing.status).toBe(428);
    const ok = await wiki.deleteSpace(
      "editor",
      space.documentId,
      await storedRevision(t, WIKI_SPACE, space.documentId),
    );
    expect(ok.status).toBe(204);
    expect(await rowsOf(t, WIKI_SPACE, space.documentId)).toEqual([]);
    // A department head never deletes (no grant).
    const other = await seedSpace(t);
    expect((await wiki.deleteSpace("department_head", other.documentId, 1)).status).toBe(403);
  });

  it("the admin panel can neither unpublish nor delete a space with pages", async () => {
    const panel = await contentManager(t);
    const space = await seedSpace(t);
    await seedPage(t, { space: space.documentId });
    const unpublish = await panel.unpublish(WIKI_SPACE, space.documentId);
    expect(unpublish.status).toBe(400);
    expect(unpublish.text).toContain("This space still has pages");
    const remove = await panel.delete(WIKI_SPACE, space.documentId);
    expect(remove.status).toBe(400);
    const rows = await rowsOf(t, WIKI_SPACE, space.documentId);
    expect(rows.filter((row) => row.publishedAt != null)).toHaveLength(1);
  });
});
