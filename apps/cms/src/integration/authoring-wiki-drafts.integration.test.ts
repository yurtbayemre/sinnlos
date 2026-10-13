import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { storedRevision } from "./authoring.test.helper";
import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";
import {
  WIKI_PAGE,
  linkParentRaw,
  parentsOf,
  rowsOf,
  seedPage,
  seedSpace,
  wikiApi,
  type WikiApi,
} from "./wiki.test.helper";

/**
 * Wiki pages on the v2 write model (deep-dive decision 06 §J2, §C; batch 16
 * lane 16B items 3 and 4; spike 2's S2.1-S2.6 without the experimental read
 * policy) on SQLite and Postgres 16:
 *   - the rebuilt can-edit-wiki: the row classes (author, the head of the
 *     page's department, the lead of its team) on every row, moderators as
 *     the `moderator` class with their payloads checked;
 *   - drafts only through createDraft and saveDraft (fixed answers); the
 *     generic reads never show a draft to a non-moderator (S2.4's channels
 *     stay closed because no generic route offers them);
 *   - `If-Match` on every change, the generic PUT included;
 *   - discard of a never-published page: its author or a moderator (it
 *     deletes it), the other classes 404; unpublish and the list:
 *     moderators.
 */

describe.each(testEngines())("authoring wiki drafts on %s", (engine) => {
  let t: TestStrapi;
  let wiki: WikiApi;
  let open: Row & { documentId: string };
  let hidden: Row & { documentId: string };
  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    wiki = wikiApi(t);
    open = await seedSpace(t, { name: "IT Open Space" });
    hidden = await seedSpace(t, {
      name: "IT Editors Space",
      visibility: "role",
      allowedRoles: [
        (
          await t.strapi.db
            .query("plugin::users-permissions.role")
            .findOne({ where: { type: "editor" } })
        )?.documentId,
      ],
    });
  });
  afterAll(async () => {
    await t?.stop();
  });

  /** What a role reads of a page through the generic read routes. */
  const readable = async (role: "member" | "department_head" | "team_lead", slug: string) =>
    (
      await t.api<{ data: { title: string }[] }>(
        role,
        `/api/wiki-pages?filters[slug][$eq]=${slug}&status=draft`,
      )
    ).body.data;

  it("S2.1: a department head drafts a page; nobody reads the draft through the generic routes", async () => {
    const res = await wiki.createDraft("department_head", {
      title: "IT Head Draft",
      body: "draft body",
      space: open.documentId,
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body.data).toMatchObject({
      status: "draft",
      publishedAt: null,
      slug: expect.stringMatching(/^it-head-draft-[0-9a-f]{8}$/),
      spaceSlug: open.slug,
    });
    const rows = await rowsOf(t, WIKI_PAGE, res.body.data.documentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].publishedAt).toBeNull();
    for (const role of ["member", "department_head", "team_lead"] as const) {
      expect(await readable(role, res.body.data.slug), role).toEqual([]);
    }
    // Its own form and drafts list show it.
    const form = await wiki.editable<Record<string, unknown>>(
      "department_head",
      "wiki-pages",
      res.body.data.documentId,
    );
    expect(form.status).toBe(200);
    expect(form.body.data).toMatchObject({
      roleClass: "author",
      title: "IT Head Draft",
      authorName: "Fixture department_head",
      canDiscardUnpublished: true,
    });
    expect(form.body.data).not.toHaveProperty("department");
    const mine = await wiki.myDrafts<{ documentId: string; status: string }>("department_head");
    expect(mine.status).toBe(200);
    expect(mine.body.data).toContainEqual(
      expect.objectContaining({ documentId: res.body.data.documentId, status: "draft" }),
    );
    // Another user's form: like a page that does not exist.
    expect((await wiki.editable("member", "wiki-pages", res.body.data.documentId)).status).toBe(
      404,
    );
  });

  it("S2.2: saveDraft needs If-Match and saves the draft only; publish publishes it", async () => {
    const created = await wiki.createDraft("team_lead", {
      title: "IT Lead Page",
      space: open.documentId,
    });
    const { documentId, version } = created.body.data;
    expect((await wiki.saveDraft("team_lead", documentId, { body: "v2" })).status).toBe(428);
    const saved = await wiki.saveDraft(
      "team_lead",
      documentId,
      { body: "v2", revisionSummary: "second" },
      version,
    );
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.data.status).toBe("draft");
    const published = await wiki.action(
      "team_lead",
      documentId,
      "publish",
      saved.body.data.version,
    );
    expect(published.status, published.text).toBe(200);
    expect(published.body.data.status).toBe("published");
    expect((await readable("member", created.body.data.slug)).map((p) => p.title)).toEqual([
      "IT Lead Page",
    ]);
    // A further draft save makes it "modified"; the published version stays.
    const modified = await wiki.saveDraft(
      "team_lead",
      documentId,
      { title: "IT Lead Page v3" },
      published.body.data.version,
    );
    expect(modified.body.data.status).toBe("modified");
    expect((await readable("member", created.body.data.slug)).map((p) => p.title)).toEqual([
      "IT Lead Page",
    ]);
    const mine = await wiki.myDrafts<{ documentId: string; status: string }>("team_lead");
    expect(mine.body.data).toContainEqual(
      expect.objectContaining({ documentId, status: "modified" }),
    );
  });

  it("S2.3: the generic routes stay pinned to published for the author classes and need If-Match", async () => {
    const created = await wiki.createPage(
      "department_head",
      { title: "IT Generic", space: open.documentId },
      "draft",
    );
    expect(created.status, created.text).toBe(201);
    // ?status=draft is overwritten: an author's generic write publishes.
    expect(created.body.data.status).toBe("published");
    const { documentId, version } = created.body.data;
    expect(
      (await wiki.updatePage("department_head", documentId, { title: "x" }, { status: "draft" }))
        .status,
    ).toBe(428);
    const updated = await wiki.updatePage(
      "department_head",
      documentId,
      { title: "IT Generic 2", revisionSummary: "note" },
      { status: "draft", version },
    );
    expect(updated.status, updated.text).toBe(200);
    expect(updated.body.data.status).toBe("published");
    // No client query on a write.
    const populate = await wiki.updatePage(
      "department_head",
      documentId,
      { title: "y" },
      { status: "published&populate=space", version: updated.body.data.version },
    );
    expect(populate.status).toBe(400);
    expect(populate.body.error?.details).toEqual({ keys: ["populate"] });
    // A member holds no create grant.
    expect(
      (await wiki.createPage("member", { title: "IT Member", space: open.documentId })).status,
    ).toBe(403);
    expect(
      (await wiki.createDraft("member", { title: "IT Member", space: open.documentId })).status,
    ).toBe(403);
  });

  it("S2.5: the row classes on every row; a numeric id of the published row resolves to the draft", async () => {
    const page = await seedPage(t, {
      title: "IT Engineering Page",
      space: open.documentId,
      department: t.fixtures.departments.engineering.documentId,
      author: t.fixtures.users.member.id,
    });
    const rows = await rowsOf(t, WIKI_PAGE, page.documentId);
    const published = rows.find((row) => row.publishedAt != null) as Row;
    // The head of the page's department, by the published row's id.
    const byRowId = await wiki.editable<{ roleClass: string; documentId: string }>(
      "department_head",
      "wiki-pages",
      String(published.id),
    );
    expect(byRowId.status, byRowId.text).toBe(200);
    expect(byRowId.body.data).toMatchObject({
      roleClass: "departmentHead",
      documentId: page.documentId,
    });
    expect(
      (await wiki.editable<{ roleClass: string }>("member", "wiki-pages", page.documentId)).body
        .data.roleClass,
    ).toBe("author");
    // A team lead without the team: no class.
    expect((await wiki.editable("team_lead", "wiki-pages", page.documentId)).status).toBe(404);
    // A moderator moves the draft's department to Sales: the head loses the
    // class (the published row still says Engineering: every row must give one).
    const version = await storedRevision(t, WIKI_PAGE, page.documentId);
    const moved = await wiki.updatePage(
      "editor",
      page.documentId,
      { department: t.fixtures.departments.sales.documentId },
      { status: "draft", version },
    );
    expect(moved.status, moved.text).toBe(200);
    expect((await wiki.editable("department_head", "wiki-pages", page.documentId)).status).toBe(
      404,
    );
  });

  it("S2.6: a team lead's draft is invisible to the department head; author-only discard of a never-published page", async () => {
    const draft = await wiki.createDraft("team_lead", {
      title: "IT Lead Secret",
      space: open.documentId,
    });
    const { documentId, version } = draft.body.data;
    expect((await wiki.editable("department_head", "wiki-pages", documentId)).status).toBe(404);
    expect(
      (await wiki.action("department_head", documentId, "discard-draft", version)).status,
    ).toBe(404);
    // A moderator gives it the team: the lead stays author; the head still has no class.
    const teamed = await wiki.updatePage(
      "editor",
      documentId,
      {
        team: t.fixtures.teams.platform.documentId,
        department: t.fixtures.departments.engineering.documentId,
      },
      { status: "draft", version },
    );
    expect(teamed.status, teamed.text).toBe(200);
    // Now the head of Engineering has a class, but may not delete the never-published page.
    const headDiscard = await wiki.action(
      "department_head",
      documentId,
      "discard-draft",
      teamed.body.data.version,
    );
    expect(headDiscard.status).toBe(404);
    expect(await rowsOf(t, WIKI_PAGE, documentId)).toHaveLength(1);
    const authorDiscard = await wiki.action(
      "team_lead",
      documentId,
      "discard-draft",
      teamed.body.data.version,
    );
    expect(authorDiscard.status, authorDiscard.text).toBe(204);
    expect(await rowsOf(t, WIKI_PAGE, documentId)).toEqual([]);
  });

  it("unpublish and the /manage list are the moderators'; a discard with a published row returns to it", async () => {
    const created = await wiki.createPage("team_lead", { title: "IT Pub", space: open.documentId });
    const { documentId } = created.body.data;
    const saved = await wiki.saveDraft(
      "team_lead",
      documentId,
      { title: "IT Pub v2" },
      created.body.data.version,
    );
    expect(
      (await wiki.action("team_lead", documentId, "unpublish", saved.body.data.version)).status,
    ).toBe(403);
    expect((await wiki.list("team_lead", "wiki-pages")).status).toBe(403);
    const discarded = await wiki.action(
      "team_lead",
      documentId,
      "discard-draft",
      saved.body.data.version,
    );
    expect(discarded.status, discarded.text).toBe(200);
    expect(discarded.body.data.status).toBe("published");
    const unpublished = await wiki.action(
      "editor",
      documentId,
      "unpublish",
      discarded.body.data.version,
    );
    expect(unpublished.status, unpublished.text).toBe(200);
    expect(unpublished.body.data.status).toBe("draft");
    const list = await wiki.list<{ documentId: string; status: string; space: string }>(
      "editor",
      "wiki-pages",
      `space=${open.documentId}&status=draft`,
    );
    expect(list.status).toBe(200);
    expect(list.body.data).toContainEqual(
      expect.objectContaining({ documentId, status: "draft", space: open.documentId }),
    );
  });

  it("moderators write every space with their rule: department, team, a schedule; no slug, no space move", async () => {
    const created = await wiki.createPage(
      "editor",
      {
        title: "IT Moderator Page",
        space: hidden.documentId,
        department: t.fixtures.departments.engineering.documentId,
        revisionSummary: "first",
      },
      "draft",
    );
    expect(created.status, created.text).toBe(201);
    expect(created.body.data.status).toBe("draft");
    const { documentId, version } = created.body.data;
    const refused = await wiki.updatePage(
      "editor",
      documentId,
      { slug: "x", space: open.documentId, author: t.fixtures.users.member.id },
      { status: "draft", version },
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error?.details).toEqual({ keys: ["author", "slug", "space"] });
    const scheduled = await wiki.updatePage(
      "editor",
      documentId,
      { publishAt: new Date(Date.now() + 3_600_000).toISOString() },
      { status: "draft", version },
    );
    expect(scheduled.status, scheduled.text).toBe(200);
    expect(scheduled.body.data.publishAt).not.toBeNull();
    // An author never schedules.
    const own = await wiki.createDraft("team_lead", { title: "IT Sched", space: open.documentId });
    const authorSchedule = await wiki.saveDraft(
      "team_lead",
      own.body.data.documentId,
      { publishAt: new Date(Date.now() + 3_600_000).toISOString() },
      own.body.data.version,
    );
    expect(authorSchedule.status).toBe(400);
    expect(authorSchedule.body.error?.details).toEqual({ keys: ["publishAt"] });
  });

  it("a page's space must stay readable for its non-moderator editors", async () => {
    const page = await seedPage(t, {
      title: "IT In Hidden",
      space: hidden.documentId,
      author: t.fixtures.users.member.id,
    });
    expect((await wiki.editable("member", "wiki-pages", page.documentId)).status).toBe(404);
    const version = await storedRevision(t, WIKI_PAGE, page.documentId);
    expect(
      (
        await wiki.updatePage(
          "member",
          page.documentId,
          { title: "x" },
          { status: "published", version },
        )
      ).status,
    ).toBe(403);
  });

  it("a title-only save inside a legacy parent loop, carrying its unchanged parent, passes the gate and the wiki checks", async () => {
    const a = await seedPage(t, {
      title: "IT Loop A",
      space: open.documentId,
      author: t.fixtures.users.member.id,
    });
    const b = await seedPage(t, {
      title: "IT Loop B",
      space: open.documentId,
      parent: a.documentId,
    });
    const aRows = await rowsOf(t, WIKI_PAGE, a.documentId);
    const bRows = await rowsOf(t, WIKI_PAGE, b.documentId);
    // a's rows get b as their parent raw: a <-> b on both twins.
    for (const row of aRows) {
      const twin = bRows.find(
        (candidate) => (candidate.publishedAt == null) === (row.publishedAt == null),
      );
      await linkParentRaw(t, row.id, (twin as Row).id);
    }
    expect(await parentsOf(t, a.documentId)).toEqual([b.documentId, b.documentId]);
    const version = await storedRevision(t, WIKI_PAGE, a.documentId);
    const saved = await wiki.updatePage(
      "member",
      a.documentId,
      { title: "IT Loop A renamed", parent: b.documentId },
      { status: "published", version },
    );
    expect(saved.status, saved.text).toBe(200);
    // The repair: clear the parent.
    const repaired = await wiki.updatePage(
      "member",
      a.documentId,
      { parent: null },
      { status: "published", version: saved.body.data.version },
    );
    expect(repaired.status, repaired.text).toBe(200);
    expect(await parentsOf(t, a.documentId)).toEqual([null, null]);
  });

  it("refuses a parent below the page with parentCycle, for the author and the moderator", async () => {
    const top = await wiki.createPage("department_head", {
      title: "IT Top",
      space: open.documentId,
    });
    const child = await wiki.createPage("department_head", {
      title: "IT Child",
      space: open.documentId,
      parent: top.body.data.documentId,
    });
    expect(child.status, child.text).toBe(201);
    for (const role of ["department_head", "editor"] as const) {
      const res = await wiki.saveDraft(
        role,
        top.body.data.documentId,
        { parent: child.body.data.documentId },
        await storedRevision(t, WIKI_PAGE, top.body.data.documentId),
      );
      expect(res.status, role).toBe(400);
      expect(res.body.error?.details, role).toEqual({
        keys: ["parent"],
        codes: { parent: "parentCycle" },
      });
    }
  });
});
