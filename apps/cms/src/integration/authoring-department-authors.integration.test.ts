import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createUser, signIn } from "./admin-api.test.helper";
import {
  authoringApi,
  notifiedUserIds,
  settleFanouts,
  storedRevision,
  type AuthoringApi,
} from "./authoring.test.helper";
import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";
import { holdTransaction, qualified, settle, waitForLockWait } from "./pg-lock.test.helper";

/**
 * Department authors (deep-dive decision 06 amendment 1, §N10; batch 15
 * lane 15A) on SQLite and Postgres 16: a `department_head` with a
 * department writes announcements, events and documents for that
 * department through the same routes, gate and lock as moderators.
 *   - pinned targeting: another department, null, another department's
 *     team, `departments: []` and two departments answer 400 `invalid`
 *     (keys only); the moderator-only keys answer 400 with their keys;
 *     DELETE answers 403;
 *   - ownership: department-owned (ownerDepartment), not person-owned; a
 *     moderator's item is not theirs (404 on the custom actions, 403 on the
 *     generic PUT); a moderator's widening takes it away, narrowing back
 *     returns it; two heads with one token end in 200 and 412;
 *   - head changes and a department delete take effect on the next request;
 *   - the discard rule (amendment row A1): no published version, no
 *     discard (400 _form neverPublished); comments and RSVPs survive;
 *   - the gate is bound to the lock (amendment row A2, Postgres): a save
 *     carrying the predicted next revision after a widening answers 404/403
 *     and writes nothing;
 *   - the thread rule (batch 12) and the audit actorClass.
 * The department-delete flags and the event fan-out rule (15D) have their
 * own suite (targeting-fail-closed.integration.test.ts).
 */
const A = "api::announcement.announcement";
const E = "api::event.event";
const D = "api::document.document";
const DEPARTMENT = "api::department.department";
const TEAM = "api::team.team";
const USER = "plugin::users-permissions.user";

describe.each(testEngines())("authoring: department authors on %s", (engine) => {
  let t: TestStrapi;
  let api: AuthoringApi;
  let engineering: Row;
  let sales: Row;
  let salesTeam: Row;
  let salesMember: { id: number; jwt: string };
  let secondHead: { id: number; jwt: string };

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    api = authoringApi(t);
    engineering = t.fixtures.departments.engineering;
    sales = t.fixtures.departments.sales;
    salesTeam = await t.strapi.documents(TEAM).create({
      data: { name: "IT Sales Team", slug: "it-sales-team", department: sales.id },
    });
    const member = await createUser(t, "member", sales);
    salesMember = { id: member.id, jwt: await signIn(t, member) };
    const head = await createUser(t, "department_head", engineering);
    secondHead = { id: head.id, jwt: await signIn(t, head) };
  });
  afterAll(async () => {
    await t?.stop();
  });

  const rowsOf = (uid: string, documentId: string, populate: Record<string, unknown> = {}) =>
    t.strapi.db.query(uid).findMany({ where: { documentId }, populate });

  describe("create, save, preview, publish, unpublish and discard", () => {
    let announcement = { documentId: "", version: "" };

    it("creates an announcement for their department: pinned, owned, the caller as author", async () => {
      const res = await api.create(
        "department_head",
        "announcements",
        { title: "Eng news" },
        "draft",
      );
      expect(res.status, res.text).toBe(201);
      announcement = { documentId: res.body.data.documentId, version: res.body.data.version };
      const [draft] = await rowsOf(A, announcement.documentId, {
        department: { select: ["id"] },
        ownerDepartment: { select: ["id"] },
        author: { select: ["id"] },
      });
      expect((draft.department as { id: number }).id).toBe(engineering.id);
      expect((draft.ownerDepartment as { id: number }).id).toBe(engineering.id);
      expect((draft.author as { id: number }).id).toBe(t.fixtures.users.department_head.id);
      expect(draft.audience).toBe("departments");
    });

    it("previews through editable: their rule's fields, the owner and the pinned department", async () => {
      const form = await api.editable<Record<string, unknown>>(
        "department_head",
        "announcements",
        announcement.documentId,
      );
      expect(form.status, form.text).toBe(200);
      expect(form.body.data).toMatchObject({
        roleClass: "departmentAuthor",
        title: "Eng news",
        department: engineering.documentId,
        team: null,
        audienceRoles: [],
        ownerDepartment: { documentId: engineering.documentId, name: "IT Engineering" },
        needsRetarget: false,
        status: "draft",
      });
      for (const key of ["pinned", "requiresAck", "ackDeadline", "publishAt", "scheduleError"]) {
        expect(form.body.data, key).not.toHaveProperty(key);
      }
    });

    it("publishes: the Engineering member reads it and is notified once, Sales neither, the author never", async () => {
      const res = await api.action(
        "department_head",
        "announcements",
        announcement.documentId,
        "publish",
        announcement.version,
      );
      expect(res.status, res.text).toBe(200);
      announcement.version = res.body.data.version;
      expect((await t.api("member", `/api/announcements/${announcement.documentId}`)).status).toBe(
        200,
      );
      expect(
        (await t.api({ jwt: salesMember.jwt }, `/api/announcements/${announcement.documentId}`))
          .status,
      ).toBe(404);
      await settleFanouts(t);
      const notified = await notifiedUserIds(t, announcement.documentId);
      expect(notified).toContain(t.fixtures.users.member.id);
      expect(notified).toContain(secondHead.id);
      expect(notified).not.toContain(t.fixtures.users.department_head.id);
      expect(notified).not.toContain(salesMember.id);
      expect(new Set(notified).size).toBe(notified.length);
    });

    it("the thread follows the batch-12 rule: an unpublish hides it, the republish restores it", async () => {
      const target = { targetType: "announcement", targetDocumentId: announcement.documentId };
      const comment = await t.api<{ data: { id: number } }>("member", "/api/comments", {
        json: { data: { body: "great", ...target } },
      });
      expect(comment.status).toBe(201);
      const filter = `filters[targetType][$eq]=announcement&filters[targetDocumentId][$eq]=${announcement.documentId}`;
      const unpublish = await api.action(
        "department_head",
        "announcements",
        announcement.documentId,
        "unpublish",
        announcement.version,
      );
      expect(unpublish.status, unpublish.text).toBe(200);
      announcement.version = unpublish.body.data.version;
      const hidden = await t.api<{ data: unknown[] }>("member", `/api/comments?${filter}`);
      expect(hidden.body.data).toEqual([]);
      const publish = await api.action(
        "department_head",
        "announcements",
        announcement.documentId,
        "publish",
        announcement.version,
      );
      expect(publish.status).toBe(200);
      announcement.version = publish.body.data.version;
      const back = await t.api<{ data: { id: number }[] }>("member", `/api/comments?${filter}`);
      expect(back.body.data.map((c) => c.id)).toEqual([comment.body.data.id]);
    });

    it("discards its changes while a published version exists", async () => {
      const save = await api.update(
        "department_head",
        "announcements",
        announcement.documentId,
        { title: "Eng news (edit)" },
        { version: announcement.version },
      );
      expect(save.status, save.text).toBe(200);
      expect(save.body.data.status).toBe("modified");
      const discard = await api.action(
        "department_head",
        "announcements",
        announcement.documentId,
        "discard-draft",
        save.body.data.version,
      );
      expect(discard.status, discard.text).toBe(200);
      expect(discard.body.data.status).toBe("published");
      announcement.version = discard.body.data.version;
      const form = await api.editable<{ title: string }>(
        "department_head",
        "announcements",
        announcement.documentId,
      );
      expect(form.body.data.title).toBe("Eng news");
    });

    it("an event: departments pinned to theirs, visible calendar-wide, only Engineering notified", async () => {
      const res = await api.create(
        "department_head",
        "events",
        { title: "Eng offsite", start: "2026-12-01T09:00:00.000Z" },
        "published",
      );
      expect(res.status, res.text).toBe(201);
      const id = res.body.data.documentId;
      const rows = await rowsOf(E, id, {
        departments: { select: ["id"] },
        ownerDepartment: { select: ["id"] },
      });
      for (const row of rows) {
        expect((row.departments as { id: number }[]).map((d) => d.id)).toEqual([engineering.id]);
        expect((row.ownerDepartment as { id: number }).id).toBe(engineering.id);
        expect(row.notifyAudience).toBe("departments");
      }
      expect((await t.api({ jwt: salesMember.jwt }, `/api/events/${id}`)).status).toBe(200);
      await settleFanouts(t);
      const notified = await notifiedUserIds(t, id);
      expect(notified).toContain(t.fixtures.users.member.id);
      expect(notified).not.toContain(salesMember.id);
      expect(notified).not.toContain(t.fixtures.users.department_head.id);
    });

    it("a document (gate only, no file before batch 16)", async () => {
      const res = await api.create(
        "department_head",
        "documents",
        { title: "Eng policy" },
        "published",
      );
      expect(res.status, res.text).toBe(201);
      const [row] = await rowsOf(D, res.body.data.documentId, { departments: { select: ["id"] } });
      expect((row.departments as { id: number }[]).map((d) => d.id)).toEqual([engineering.id]);
      expect(row.audience).toBe("departments");
      const file = await api.update(
        "department_head",
        "documents",
        res.body.data.documentId,
        { file: 1 },
        { version: res.body.data.version },
      );
      expect(file.status).toBe(400);
      expect(file.body.error?.details).toEqual({ keys: ["file"] });
    });

    it("cannot author quick links or polls (no grant)", async () => {
      expect(
        (await api.create("department_head", "quick-links", { label: "x", url: "/x" }, "draft"))
          .status,
      ).toBe(403);
      expect(
        (await api.create("department_head", "polls", { question: "?", options: ["a", "b"] }, null))
          .status,
      ).toBe(403);
      expect((await api.list("department_head", "polls")).status).toBe(403);
    });
  });

  describe("pinned targeting and refused keys", () => {
    let item = { documentId: "", version: "" };

    beforeAll(async () => {
      const res = await api.create(
        "department_head",
        "announcements",
        { title: "Pinned" },
        "draft",
      );
      item = { documentId: res.body.data.documentId, version: res.body.data.version };
    });

    it("refuses another department, null, another department's team, [] and two departments: keys only", async () => {
      const cases: [string, string, Record<string, unknown>][] = [
        ["announcements", item.documentId, { department: sales.documentId }],
        ["announcements", item.documentId, { department: null }],
        ["announcements", item.documentId, { team: salesTeam.documentId }],
      ];
      for (const [plural, id, data] of cases) {
        const res = await api.update("department_head", plural, id, data, {
          version: item.version,
        });
        expect(res.status, JSON.stringify(data)).toBe(400);
        expect(res.body.error?.details, JSON.stringify(data)).toEqual({ keys: Object.keys(data) });
      }
      for (const departments of [
        [],
        [engineering.documentId, sales.documentId],
        [sales.documentId],
      ]) {
        const res = await api.create(
          "department_head",
          "events",
          { title: "x", start: "2026-12-01T09:00:00.000Z", departments },
          "draft",
        );
        expect(res.status, JSON.stringify(departments)).toBe(400);
        expect(res.body.error?.details).toEqual({ keys: ["departments"] });
      }
      // A team of their own department is fine; staff role types only.
      const team = await api.update(
        "department_head",
        "announcements",
        item.documentId,
        { team: t.fixtures.teams.platform.documentId, audienceRoles: ["member"] },
        { version: item.version },
      );
      expect(team.status, team.text).toBe(200);
      item.version = team.body.data.version;
      const guest = await api.update(
        "department_head",
        "announcements",
        item.documentId,
        { audienceRoles: ["guest"] },
        { version: item.version },
      );
      expect(guest.body.error?.details).toEqual({ keys: ["audienceRoles"] });
    });

    it("refuses pinned, requiresAck, publishAt and ownerDepartment with their keys; DELETE is 403", async () => {
      for (const data of [
        { pinned: true },
        { requiresAck: true },
        { publishAt: "2026-12-01T09:00:00.000Z" },
        { ownerDepartment: sales.documentId },
      ]) {
        const res = await api.update("department_head", "announcements", item.documentId, data, {
          version: item.version,
        });
        expect(res.status, JSON.stringify(data)).toBe(400);
        expect(res.body.error?.details, JSON.stringify(data)).toEqual({ keys: Object.keys(data) });
      }
      expect(
        (await api.remove("department_head", "announcements", item.documentId, item.version))
          .status,
      ).toBe(403);
      expect(await t.strapi.db.query(A).count({ where: { documentId: item.documentId } })).toBe(1);
    });
  });

  describe("ownership, takeover and two heads", () => {
    it("an editor's Engineering announcement is not theirs: 404 on editable and actions, 403 on PUT, not listed", async () => {
      const res = await api.create(
        "editor",
        "announcements",
        { title: "HR mandate", department: engineering.documentId, requiresAck: true },
        "published",
      );
      const id = res.body.data.documentId;
      const version = res.body.data.version;
      expect((await api.editable("department_head", "announcements", id)).status).toBe(404);
      expect(
        (await api.update("department_head", "announcements", id, { title: "x" }, { version }))
          .status,
      ).toBe(403);
      for (const action of ["publish", "unpublish", "discard-draft"] as const) {
        expect(
          (await api.action("department_head", "announcements", id, action, version)).status,
          action,
        ).toBe(404);
      }
      const list = await api.list<{ documentId: string }>("department_head", "announcements");
      expect(list.status).toBe(200);
      expect(list.body.data.map((row) => row.documentId)).not.toContain(id);
      // A malformed or unknown id answers the same 404.
      expect(
        (await api.editable("department_head", "announcements", "zzzzzzzzzzzzzzzzzzzzzzzz")).status,
      ).toBe(404);
      expect((await api.editable("department_head", "announcements", "999999")).status).toBe(404);
    });

    it("a second head of the department edits the first head's item; one token: 200 then 412", async () => {
      const res = await api.create(
        "department_head",
        "announcements",
        { title: "Shared" },
        "draft",
      );
      const id = res.body.data.documentId;
      const version = res.body.data.version;
      const second = await api.update(
        { jwt: secondHead.jwt },
        "announcements",
        id,
        { title: "By the deputy" },
        { version },
      );
      expect(second.status, second.text).toBe(200);
      const first = await api.update(
        "department_head",
        "announcements",
        id,
        { title: "By the head" },
        { version },
      );
      expect(first.status).toBe(412);
      expect(first.body.error?.details).toEqual({ current: Number(second.body.data.version) });
      const list = await api.list<{ documentId: string; ownerDepartment: unknown }>(
        { jwt: secondHead.jwt },
        "announcements",
      );
      expect(list.body.data.map((row) => row.documentId)).toContain(id);
    });

    it("an editor's widening takes the item away; narrowing it back returns it", async () => {
      const res = await api.create(
        "department_head",
        "announcements",
        { title: "Widen me" },
        "published",
      );
      const id = res.body.data.documentId;
      const form = await api.editable<{ version: string }>("editor", "announcements", id);
      const widened = await api.update(
        "editor",
        "announcements",
        id,
        { department: null },
        { status: "published", version: form.body.data.version },
      );
      expect(widened.status, widened.text).toBe(200);
      expect((await api.editable("department_head", "announcements", id)).status).toBe(404);
      expect(
        (
          await api.update(
            "department_head",
            "announcements",
            id,
            { title: "x" },
            { version: widened.body.data.version },
          )
        ).status,
      ).toBe(403);
      const moderatorList = await api.list<{
        documentId: string;
        ownerDepartment: { documentId: string } | null;
      }>("editor", "announcements", "owner=department");
      expect(
        moderatorList.body.data.find((row) => row.documentId === id)?.ownerDepartment?.documentId,
      ).toBe(engineering.documentId);
      const narrowed = await api.update(
        "editor",
        "announcements",
        id,
        { department: engineering.documentId },
        { status: "published", version: widened.body.data.version },
      );
      expect(narrowed.status).toBe(200);
      const back = await api.update(
        "department_head",
        "announcements",
        id,
        { title: "Mine again" },
        { version: narrowed.body.data.version },
      );
      expect(back.status, back.text).toBe(200);
    });
  });

  describe("head changes take effect on the next request", () => {
    it("a demoted head loses the items; a head moved to Sales authors for Sales only", async () => {
      const head = await createUser(t, "department_head", engineering);
      const jwt = await signIn(t, head);
      const res = await api.create(
        { jwt },
        "announcements",
        { title: "Before the change" },
        "draft",
      );
      expect(res.status).toBe(201);
      const id = res.body.data.documentId;
      const version = res.body.data.version;

      const member = await t.strapi.db
        .query("plugin::users-permissions.role")
        .findOne({ where: { type: "member" } });
      const headRole = await t.strapi.db
        .query("plugin::users-permissions.role")
        .findOne({ where: { type: "department_head" } });
      await t.strapi.db.query(USER).update({ where: { id: head.id }, data: { role: member!.id } });
      expect(
        (await api.update({ jwt }, "announcements", id, { title: "x" }, { version })).status,
      ).toBe(403);
      expect((await api.editable({ jwt }, "announcements", id)).status).toBe(403);

      await t.strapi.db.query(USER).update({
        where: { id: head.id },
        data: { role: headRole!.id, department: sales.id },
      });
      expect((await api.editable({ jwt }, "announcements", id)).status).toBe(404);
      const salesItem = await api.create(
        { jwt },
        "announcements",
        { title: "Sales news" },
        "draft",
      );
      expect(salesItem.status, salesItem.text).toBe(201);
      const [row] = await rowsOf(A, salesItem.body.data.documentId, {
        department: { select: ["id"] },
      });
      expect((row.department as { id: number }).id).toBe(sales.id);

      await t.strapi.db.query(USER).update({ where: { id: head.id }, data: { department: null } });
      expect(
        (await api.create({ jwt }, "announcements", { title: "No department" }, "draft")).status,
      ).toBe(403);
      expect((await api.list({ jwt }, "announcements")).status).toBe(403);
    });

    it("a department delete leaves the items to moderators, marked as needing re-targeting", async () => {
      const temp = await t.strapi
        .documents(DEPARTMENT)
        .create({ data: { name: "IT Temp", slug: "it-temp" } });
      const head = await createUser(t, "department_head", temp);
      const jwt = await signIn(t, head);
      const announcement = await api.create(
        { jwt },
        "announcements",
        { title: "Temp news" },
        "published",
      );
      const event = await api.create(
        { jwt },
        "events",
        { title: "Temp event", start: "2026-12-02T09:00:00.000Z" },
        "published",
      );
      expect([announcement.status, event.status]).toEqual([201, 201]);
      const deleted = await t.api("admin_role", `/api/departments/${temp.documentId}`, {
        method: "DELETE",
      });
      expect([200, 204]).toContain(deleted.status);
      for (const [plural, created] of [
        ["announcements", announcement],
        ["events", event],
      ] as const) {
        const id = created.body.data.documentId;
        expect((await api.editable({ jwt }, plural, id)).status, plural).not.toBe(200);
        const list = await api.list<{
          documentId: string;
          needsRetarget: boolean;
          ownerDepartment: unknown;
        }>("editor", plural, "q=temp");
        expect(
          list.body.data.find((row) => row.documentId === id),
          plural,
        ).toMatchObject({
          needsRetarget: true,
          ownerDepartment: null,
        });
      }
      expect(
        (await t.api("member", `/api/announcements/${announcement.body.data.documentId}`)).status,
      ).toBe(404);
    });
  });

  describe("the discard rule (amendment row A1)", () => {
    it("publish, unpublish, discard: 400 neverPublished, and the announcement and its comments stay", async () => {
      const res = await api.create(
        "department_head",
        "announcements",
        { title: "Keep me" },
        "published",
      );
      const id = res.body.data.documentId;
      const comment = await t.api("member", "/api/comments", {
        json: { data: { body: "hello", targetType: "announcement", targetDocumentId: id } },
      });
      expect(comment.status).toBe(201);
      const unpublish = await api.action(
        "department_head",
        "announcements",
        id,
        "unpublish",
        res.body.data.version,
      );
      expect(unpublish.status).toBe(200);
      const discard = await api.action(
        "department_head",
        "announcements",
        id,
        "discard-draft",
        unpublish.body.data.version,
      );
      expect(discard.status).toBe(400);
      expect(discard.body.error?.details).toEqual({
        keys: ["_form"],
        codes: { _form: "neverPublished" },
      });
      expect(await t.strapi.db.query(A).count({ where: { documentId: id } })).toBe(1);
      expect(await storedRevision(t, A, id)).toBe(Number(unpublish.body.data.version));
      expect(
        await t.strapi.db.query("api::comment.comment").count({ where: { targetDocumentId: id } }),
      ).toBe(1);
      // A stale token still answers 412 first, not the discard rule.
      const stale = await api.action("department_head", "announcements", id, "discard-draft", 1);
      expect(stale.status).toBe(412);
    });

    it("an event's RSVPs survive; a never-published draft is refused too; an editor's discard deletes it", async () => {
      const event = await api.create(
        "department_head",
        "events",
        { title: "RSVP me", start: "2026-12-03T09:00:00.000Z", rsvpEnabled: true },
        "published",
      );
      const rsvp = await t.api("member", "/api/event-rsvps", {
        json: { data: { targetDocumentId: event.body.data.documentId, status: "yes" } },
      });
      expect(rsvp.status).toBe(200);
      const unpublish = await api.action(
        "department_head",
        "events",
        event.body.data.documentId,
        "unpublish",
        event.body.data.version,
      );
      const discard = await api.action(
        "department_head",
        "events",
        event.body.data.documentId,
        "discard-draft",
        unpublish.body.data.version,
      );
      expect(discard.status).toBe(400);
      expect(
        await t.strapi.db.query("api::event-rsvp.event-rsvp").count({
          where: { targetDocumentId: event.body.data.documentId },
        }),
      ).toBe(1);

      const draft = await api.create(
        "department_head",
        "announcements",
        { title: "Never published" },
        "draft",
      );
      const refused = await api.action(
        "department_head",
        "announcements",
        draft.body.data.documentId,
        "discard-draft",
        draft.body.data.version,
      );
      expect(refused.status).toBe(400);
      const editor = await api.action(
        "editor",
        "announcements",
        draft.body.data.documentId,
        "discard-draft",
        draft.body.data.version,
      );
      expect(editor.status).toBe(204);
      expect(
        await t.strapi.db.query(A).count({ where: { documentId: draft.body.data.documentId } }),
      ).toBe(0);
    });
  });

  it("the audit trail records the department author's class", async () => {
    const res = await api.create("department_head", "announcements", { title: "Audited" }, "draft");
    const rows = await t.strapi.db.query("api::audit-event.audit-event").findMany({
      where: { targetUid: A, targetDocumentId: res.body.data.documentId },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatchObject({
        actorKind: "user",
        actorUserId: t.fixtures.users.department_head.id,
        actorClass: "departmentAuthor",
        source: "content-api",
      });
    }
    const editor = await api.create("editor", "announcements", { title: "Audited too" }, "draft");
    const [editorRow] = await t.strapi.db.query("api::audit-event.audit-event").findMany({
      where: { targetUid: A, targetDocumentId: editor.body.data.documentId },
    });
    expect(editorRow).toMatchObject({ actorClass: "moderator", source: "content-api" });
  });

  it.runIf(engine === "postgres")(
    "A2: a save carrying the predicted next revision after a widening answers 403 and writes nothing",
    async () => {
      const created = await api.create(
        "department_head",
        "announcements",
        { title: "Bound" },
        "published",
      );
      const id = created.body.data.documentId;
      const version = Number(created.body.data.version);
      // Hold the version row: the head's save passes the gate (revision
      // `version`, owned) and waits at the lock.
      const held = await holdTransaction(t);
      await held.raw(
        `SELECT revision FROM ${qualified(t, "content_versions")} WHERE target_uid = ? AND target_document_id = ? FOR UPDATE`,
        [A, id],
      );
      const save = settle(
        api.update(
          "department_head",
          "announcements",
          id,
          { title: "Hijack" },
          { version: version + 1 },
        ),
      );
      await waitForLockWait(t);
      // The widening an editor commits while the save waits: done here as
      // the editor's rows and revision change under the held lock.
      await held.raw(
        `UPDATE ${qualified(t, "content_versions")} SET revision = revision + 1 WHERE target_uid = ? AND target_document_id = ?`,
        [A, id],
      );
      await held.raw(
        `DELETE FROM ${qualified(t, "announcements_department_lnk")} WHERE announcement_id IN (SELECT id FROM ${qualified(t, "announcements")} WHERE document_id = ?)`,
        [id],
      );
      await held.commit();
      const outcome = await save;
      expect(outcome.ok).toBe(true);
      const answer = outcome.ok ? outcome.value : null;
      // The generic PUT answers a lost class with 403 (§B5), never 412.
      expect(answer?.status).toBe(403);
      expect(answer?.body.error?.details ?? {}).not.toHaveProperty("current");
      const rows = await rowsOf(A, id);
      for (const row of rows) expect(row.title).toBe("Bound");
      expect(await storedRevision(t, A, id)).toBe(version + 1);
    },
  );

  it.runIf(engine === "postgres")(
    "A2: a department delete between the gate and the lock answers 403 and writes nothing",
    async () => {
      const temp = await t.strapi
        .documents(DEPARTMENT)
        .create({ data: { name: "IT Race", slug: "it-race" } });
      const head = await createUser(t, "department_head", temp);
      const jwt = await signIn(t, head);
      const created = await api.create({ jwt }, "announcements", { title: "Race" }, "draft");
      const id = created.body.data.documentId;
      const held = await holdTransaction(t);
      await held.raw(
        `SELECT revision FROM ${qualified(t, "content_versions")} WHERE target_uid = ? AND target_document_id = ? FOR UPDATE`,
        [A, id],
      );
      const save = settle(
        api.update(
          { jwt },
          "announcements",
          id,
          { title: "Hijack" },
          { version: created.body.data.version },
        ),
      );
      await waitForLockWait(t);
      // What the department delete hook does to the item before the
      // cascade (15D): the revision advances, then the links go.
      await held.raw(
        `UPDATE ${qualified(t, "content_versions")} SET revision = revision + 1 WHERE target_uid = ? AND target_document_id = ?`,
        [A, id],
      );
      await held.raw(
        `DELETE FROM ${qualified(t, "announcements_owner_department_lnk")} WHERE announcement_id IN (SELECT id FROM ${qualified(t, "announcements")} WHERE document_id = ?)`,
        [id],
      );
      await held.commit();
      const outcome = await save;
      const answer = outcome.ok ? outcome.value : null;
      expect(answer?.status).toBe(403);
      expect(answer?.body.error?.details ?? {}).not.toHaveProperty("current");
      const [row] = await rowsOf(A, id);
      expect(row.title).toBe("Race");
    },
  );
});
