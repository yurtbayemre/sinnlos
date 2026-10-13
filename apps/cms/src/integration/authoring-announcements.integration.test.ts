import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  authoringApi,
  notifiedUserIds,
  settleFanouts,
  storedRevision,
  type AuthoringApi,
} from "./authoring.test.helper";
import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";

/**
 * The port gate of batch 15 lane 15A (deep-dive decision 06 §B3, plan item
 * 1): announcements written through the v2 authoring controller and the
 * moderator class of global::can-author, the spike suites S1.1-S1.6 and
 * S10.1-S10.4 ported onto it, over HTTP on SQLite and Postgres 16.
 *   - status is explicit (a create without it answers 400), every other
 *     query key is refused, the answer is the fixed DTO with the ETag;
 *   - moderator payloads are no longer open: Strapi keys, ownership,
 *     targeting flags and unknown keys answer the generic 400, values carry
 *     their codes, a relation refusal carries none;
 *   - updates and the custom actions need If-Match (428), a stale one
 *     answers 412 with details.current;
 *   - audience roles are written as role types by an editor (no role.find);
 *   - the author is the caller and is not notified of their own post.
 */
const A = "api::announcement.announcement";
const P = "announcements";

describe.each(testEngines())("authoring announcements (port gate) on %s", (engine) => {
  let t: TestStrapi;
  let api: AuthoringApi;
  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    api = authoringApi(t);
  });
  afterAll(async () => {
    await t?.stop();
  });

  let documentId = "";
  let version = "";

  it("S1.1 an editor creates and publishes: the DTO, the ETag, the caller as author, derived audience", async () => {
    const eng = t.fixtures.departments.engineering.documentId;
    const res = await api.create(
      "editor",
      P,
      {
        title: "Port gate announcement",
        body: "**hello**",
        department: eng,
        requiresAck: true,
        ackDeadline: "2026-12-15",
        expiresAt: "2026-12-31T23:00:00.000Z",
      },
      "published",
    );
    expect(res.status, res.text).toBe(201);
    documentId = res.body.data.documentId;
    version = res.body.data.version;
    expect(res.body.data).toEqual({
      documentId,
      version: "1",
      status: "published",
      publishedAt: expect.any(String),
      publishAt: null,
      scheduleError: null,
    });
    expect(res.headers.get("etag")).toBe('"1"');
    expect(await storedRevision(t, A, documentId)).toBe(1);
    const rows = await t.strapi.db.query(A).findMany({
      where: { documentId },
      populate: { author: { select: ["id"] }, department: { select: ["documentId"] } },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect((row.author as { id: number }).id).toBe(t.fixtures.users.editor.id);
      expect((row.department as { documentId: string }).documentId).toBe(eng);
      expect(row.audience).toBe("departments");
      expect(row.ackDeadline).toBe("2026-12-15");
    }
  });

  it("a create without status, with another status or with a query key answers 400", async () => {
    const missing = await api.create("editor", P, { title: "x" }, null);
    expect(missing.status).toBe(400);
    expect(missing.body.error?.details).toEqual({
      keys: ["status"],
      codes: { status: "required" },
    });
    const other = await api.create("editor", P, { title: "x" }, "live");
    expect(other.body.error?.details).toEqual({ keys: ["status"], codes: { status: "invalid" } });
    const populate = await t.api<{ error?: { details?: unknown } }>(
      "editor",
      "/api/announcements?status=draft&populate=*",
      { json: { data: { title: "x" } } },
    );
    expect(populate.status).toBe(400);
    expect(populate.body.error?.details).toEqual({ keys: ["populate"] });
  });

  it("S1.2 moderator payloads are no longer open: Strapi keys, ownership and flags answer the generic 400", async () => {
    for (const extra of [
      { author: t.fixtures.users.member.id },
      { publishedAt: "2026-01-01T00:00:00.000Z" },
      { createdBy: 1 },
      { locale: "de" },
      { documentId: "abc" },
      { comments: [] },
      { audience: "all" },
      { retargetRequired: false },
      { ownerDepartment: t.fixtures.departments.engineering.documentId },
      { scheduleError: null },
    ]) {
      const res = await api.create("editor", P, { title: "x", ...extra }, "draft");
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(res.body.error?.message).toMatch(/^Invalid or disallowed data field\(s\): /);
      expect(res.body.error?.details, JSON.stringify(extra)).toEqual({ keys: Object.keys(extra) });
    }
  });

  it("S1.3 values are checked with codes; a relation refusal carries no code", async () => {
    const bad: [Record<string, unknown>, Record<string, unknown>][] = [
      [
        { expiresAt: "2026-12-31T23:00" },
        { keys: ["expiresAt"], codes: { expiresAt: "invalidInstant" } },
      ],
      [
        { ackDeadline: "2026-02-30" },
        { keys: ["ackDeadline"], codes: { ackDeadline: "invalidDate" } },
      ],
      [{ title: "" }, { keys: ["title"], codes: { title: "required" } }],
      [{ title: "x".repeat(256) }, { keys: ["title"], codes: { title: "tooLong" } }],
      [{ pinned: "yes" }, { keys: ["pinned"], codes: { pinned: "invalid" } }],
      [{ department: "zzzzzzzzzzzzzzzzzzzzzzzz" }, { keys: ["department"] }],
      [{ team: 999999 }, { keys: ["team"] }],
      [{ audienceRoles: ["public"] }, { keys: ["audienceRoles"] }],
    ];
    for (const [data, details] of bad) {
      const res = await api.update("editor", P, documentId, data, { version });
      expect(res.status, JSON.stringify(data)).toBe(400);
      expect(res.body.error?.details, JSON.stringify(data)).toEqual(details);
    }
    // Nothing was written: the revision did not move.
    expect(await storedRevision(t, A, documentId)).toBe(Number(version));
  });

  it("an update needs If-Match (428), a stale one answers 412 with the current revision", async () => {
    const missing = await api.update("editor", P, documentId, { title: "x" }, { version: null });
    expect(missing.status).toBe(428);
    const stale = await api.update("editor", P, documentId, { title: "x" }, { version: 99 });
    expect(stale.status).toBe(412);
    expect(stale.body.error?.details).toEqual({ current: Number(version) });
    const query = await api.update(
      "editor",
      P,
      documentId,
      { title: "x" },
      { version, query: "populate[author]=*" },
    );
    expect(query.status).toBe(400);
    expect(query.body.error?.details?.keys).toEqual(["populate"]);
  });

  it("S1.4 a draft-only save keeps the published version; Save and publish publishes it", async () => {
    const draft = await api.update(
      "editor",
      P,
      documentId,
      { title: "Port gate draft edit" },
      { version },
    );
    expect(draft.status, draft.text).toBe(200);
    expect(draft.body.data.status).toBe("modified");
    expect(draft.body.data.version).toBe(String(Number(version) + 1));
    expect(draft.headers.get("etag")).toBe(`"${draft.body.data.version}"`);
    version = draft.body.data.version;

    const memberView = await t.api<{ data: { title: string } }>(
      "member",
      `/api/announcements/${documentId}`,
    );
    expect(memberView.body.data.title).toBe("Port gate announcement");
    const memberDraft = await t.api<{ data: { title: string } }>(
      "member",
      `/api/announcements/${documentId}?status=draft`,
    );
    expect(memberDraft.body.data.title).toBe("Port gate announcement");
    const form = await api.editable<{ title: string; status: string }>("editor", P, documentId);
    expect(form.status).toBe(200);
    expect(form.body.data).toMatchObject({
      title: "Port gate draft edit",
      status: "modified",
      version,
    });

    const publish = await api.update("editor", P, documentId, {}, { status: "published", version });
    expect(publish.status, publish.text).toBe(200);
    expect(publish.body.data.status).toBe("published");
    version = publish.body.data.version;
    const after = await t.api<{ data: { title: string } }>(
      "member",
      `/api/announcements/${documentId}`,
    );
    expect(after.body.data.title).toBe("Port gate draft edit");
  });

  it("S1.5 non-moderators without a class cannot create or update (403)", async () => {
    for (const role of ["member", "team_lead", "guest", "authenticated"] as const) {
      const create = await api.create(role, P, { title: "nope" }, "draft");
      expect(create.status, role).toBe(403);
      const update = await api.update(role, P, documentId, { title: "nope" }, { version });
      expect(update.status, role).toBe(403);
    }
    // A department head has a class on announcements, but not on an
    // editor's item: 403 on the generic PUT (§N3).
    const head = await api.update("department_head", P, documentId, { title: "nope" }, { version });
    expect(head.status).toBe(403);
  });

  it("S10.1 retargeting to Sales hides it from an Engineering member; the editor still reads it", async () => {
    const res = await api.update(
      "editor",
      P,
      documentId,
      { department: t.fixtures.departments.sales.documentId },
      { status: "published", version },
    );
    expect(res.status, res.text).toBe(200);
    version = res.body.data.version;
    expect((await t.api("member", `/api/announcements/${documentId}`)).status).toBe(404);
    expect((await t.api("editor", `/api/announcements/${documentId}`)).status).toBe(200);
    const back = await api.update(
      "editor",
      P,
      documentId,
      { department: t.fixtures.departments.engineering.documentId },
      { status: "published", version },
    );
    expect(back.status).toBe(200);
    version = back.body.data.version;
    expect((await t.api("member", `/api/announcements/${documentId}`)).status).toBe(200);
  });

  it("S10.2 an editor writes audience roles as role types (no role.find)", async () => {
    const res = await api.update(
      "editor",
      P,
      documentId,
      { audienceRoles: ["member"] },
      { status: "published", version },
    );
    expect(res.status, res.text).toBe(200);
    version = res.body.data.version;
    const rows = await t.strapi.db.query(A).findMany({
      where: { documentId },
      populate: { audienceRoles: { select: ["type"] } },
    });
    expect(rows.map((row) => (row.audienceRoles as { type: string }[]).map((r) => r.type))).toEqual(
      [["member"], ["member"]],
    );
    expect((await t.api("member", `/api/announcements/${documentId}`)).status).toBe(200);
    expect((await t.api("team_lead", `/api/announcements/${documentId}`)).status).toBe(404);
    const form = await api.editable<{ audienceRoles: string[] }>("editor", P, documentId);
    expect(form.body.data.audienceRoles).toEqual(["member"]);
    const cleared = await api.update(
      "editor",
      P,
      documentId,
      { audienceRoles: [] },
      { status: "published", version },
    );
    expect(cleared.status).toBe(200);
    version = cleared.body.data.version;
    const roleList = await t.api("editor", "/api/users-permissions/roles");
    expect(roleList.status).toBe(403);
  });

  it("S10.3 notifications: none for a draft; once per audience member, never the author", async () => {
    const created = await api.create("editor", P, { title: "Port gate notify" }, "draft");
    expect(created.status, created.text).toBe(201);
    const id = created.body.data.documentId;
    await settleFanouts(t);
    expect(await notifiedUserIds(t, id)).toEqual([]);

    const publish = await api.action("editor", P, id, "publish", created.body.data.version);
    expect(publish.status, publish.text).toBe(200);
    expect(publish.body.data.status).toBe("published");
    await settleFanouts(t);
    const expected = (
      ["admin_role", "department_head", "team_lead", "member", "authenticated"] as const
    )
      .map((role) => t.fixtures.users[role].id)
      .sort((a, b) => a - b);
    // The editor wrote it: the author is not notified of their own post.
    expect(await notifiedUserIds(t, id)).toEqual(expected);

    const again = await api.update(
      "editor",
      P,
      id,
      { title: "Port gate notify v2" },
      { status: "published", version: publish.body.data.version },
    );
    expect(again.status).toBe(200);
    await settleFanouts(t);
    expect(await notifiedUserIds(t, id)).toEqual(expected);
  });

  it("a create with status published and a Save and publish both notify (the lifecycle sees publishedAt)", async () => {
    const sales = t.fixtures.departments.sales.documentId;
    const created = await api.create(
      "admin_role",
      P,
      { title: "Port gate sales", department: sales },
      "published",
    );
    expect(created.status, created.text).toBe(201);
    const id = created.body.data.documentId;
    await settleFanouts(t);
    // Sales has no fixture user: nobody is in the audience yet.
    expect(await notifiedUserIds(t, id)).toEqual([]);
    const widened = await api.update(
      "admin_role",
      P,
      id,
      { department: null },
      { status: "published", version: created.body.data.version },
    );
    expect(widened.status, widened.text).toBe(200);
    await settleFanouts(t);
    const everyone = (
      ["editor", "department_head", "team_lead", "member", "authenticated"] as const
    )
      .map((role) => t.fixtures.users[role].id)
      .sort((a, b) => a - b);
    expect(await notifiedUserIds(t, id)).toEqual(everyone);
  });

  it("S1.6 unpublish (custom action) hides it; the draft stays; no grant answers 403", async () => {
    const stale = await api.action("editor", P, documentId, "unpublish", Number(version) - 1);
    expect(stale.status).toBe(412);
    const missing = await api.action("editor", P, documentId, "unpublish", null);
    expect(missing.status).toBe(428);
    const res = await api.action("editor", P, documentId, "unpublish", version);
    expect(res.status, res.text).toBe(200);
    expect(res.body.data).toMatchObject({ status: "draft", publishedAt: null });
    version = res.body.data.version;
    expect((await t.api("member", `/api/announcements/${documentId}`)).status).toBe(404);
    const draft = await api.editable<{ title: string }>("editor", P, documentId);
    expect(draft.body.data.title).toBe("Port gate draft edit");
    expect((await api.action("member", P, documentId, "unpublish", version)).status).toBe(403);
    // A custom action refuses every query key.
    const query = await t.api("editor", `/api/announcements/${documentId}/publish?populate=*`, {
      method: "POST",
      headers: { "If-Match": `"${version}"` },
    });
    expect(query.status).toBe(400);
  });

  it("S10.4 an ack-required announcement can be acknowledged by its audience", async () => {
    const res = await api.create(
      "editor",
      P,
      { title: "Ack me", requiresAck: true, ackDeadline: "2026-12-01" },
      "published",
    );
    expect(res.status).toBe(201);
    const ack = await t.api("member", "/api/acknowledgements", {
      json: { data: { targetType: "announcement", targetDocumentId: res.body.data.documentId } },
    });
    expect([200, 201]).toContain(ack.status);
  });

  it("the list shows the editor's items with their state; the form reads relations as documentIds", async () => {
    const list = await api.list<{ documentId: string; status: string; authorName: string | null }>(
      "editor",
      P,
      "q=port%20gate",
    );
    expect(list.status, list.text).toBe(200);
    const row = list.body.data.find((entry) => entry.documentId === documentId);
    expect(row).toMatchObject({
      status: "draft",
      authorName: "Fixture editor",
      label: "Port gate draft edit",
      version,
      ownerDepartment: null,
      needsRetarget: false,
    });
    const form = await api.editable<{ department: string | null; ownerDepartment: unknown }>(
      "editor",
      P,
      documentId,
    );
    expect(form.headers.get("etag")).toBe(`"${version}"`);
    expect(form.body.data).toMatchObject({
      department: t.fixtures.departments.engineering.documentId,
      ownerDepartment: null,
      roleClass: "moderator",
      pinned: false,
      requiresAck: true,
    });
    const filtered = await api.list("editor", P, "status=published&q=port%20gate");
    expect(
      (filtered.body.data as { documentId: string }[]).map((entry) => entry.documentId),
    ).not.toContain(documentId);
    const refused = await api.list("editor", P, "sort=title");
    expect(refused.status).toBe(400);
    expect((await api.list("member", P)).status).toBe(403);
  });

  it("discard and delete: a moderator's discard without a published row deletes (204); delete needs If-Match", async () => {
    const created = await api.create("editor", P, { title: "Discard me" }, "draft");
    const id = created.body.data.documentId;
    const discard = await api.action("editor", P, id, "discard-draft", created.body.data.version);
    expect(discard.status, discard.text).toBe(204);
    expect(await t.strapi.db.query(A).count({ where: { documentId: id } })).toBe(0);
    expect(await storedRevision(t, A, id)).toBe(0);

    const other = await api.create("editor", P, { title: "Delete me" }, "published");
    const otherId = other.body.data.documentId;
    expect((await api.remove("editor", P, otherId, null)).status).toBe(428);
    expect((await api.remove("editor", P, otherId, 7)).status).toBe(412);
    expect((await api.remove("department_head", P, otherId, other.body.data.version)).status).toBe(
      403,
    );
    const removed = await api.remove("editor", P, otherId, other.body.data.version);
    expect(removed.status, removed.text).toBe(204);
    expect(await t.strapi.db.query(A).count({ where: { documentId: otherId } })).toBe(0);
    expect((await api.remove("editor", P, otherId, 1)).status).toBe(404);
  });
});
