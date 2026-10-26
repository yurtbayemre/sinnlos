import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createTestStrapi,
  testEngines,
  type Params,
  type Row,
  type TestStrapi,
} from "./harness.test.helper";

/**
 * v0.31 (#172, #173) over real HTTP: GET /api/me/open-acks counts what the
 * banner's former content-API reads counted (the visibility policies'
 * rules, published mandatory rows, minus the caller's receipts), null for
 * a kind the role may not read; POST /api/acknowledgements/report-index is
 * admin_role's only and keeps the report's former budget. Both close with
 * `read-confirmations`. team_lead must have a second factor here, so its
 * password session is restricted (the MFA gate's exact allowlist).
 */

const ANNOUNCEMENT = "api::announcement.announcement";
const DOCUMENT = "api::document.document";
const ACK = "api::acknowledgement.acknowledgement";
const USER = "plugin::users-permissions.user";
const PERMISSION = "plugin::users-permissions.permission";
const ROLE = "plugin::users-permissions.role";

type Counts = { data: { announcements: number | null; documents: number | null } };
type Index = { data: { acks: Record<string, number[]> }; meta: { truncated: boolean } };

/** The query-engine calls the harness's DbQuery leaves out. */
type BulkQuery = {
  updateMany(params: { where: Params; data: Params }): Promise<unknown>;
  deleteMany(params: { where: Params }): Promise<unknown>;
  createMany(params: { data: Params[] }): Promise<unknown>;
};

describe.each(testEngines())("open confirmations and the report index (v0.31) on %s", (engine) => {
  let t: TestStrapi;
  const ids: Record<string, string> = {};

  const announcement = async (
    key: string,
    data: Params,
    status: "published" | "draft" = "published",
  ) => {
    const row = await t.strapi.documents(ANNOUNCEMENT).create({
      data: { title: `IT ${key}`, audience: "all", requiresAck: true, ...data },
      status,
    });
    ids[key] = row.documentId as string;
  };
  const document = async (key: string, data: Params) => {
    const row = await t.strapi.documents(DOCUMENT).create({
      data: { title: `IT ${key}`, requiresAck: true, ...data },
      status: "published",
    });
    ids[key] = row.documentId as string;
  };
  const bulk = (uid: string) => t.strapi.db.query(uid) as unknown as BulkQuery;
  const receipt = (user: number | null, targetType: string, target: string) =>
    t.strapi.db.query(ACK).create({
      data: { ...(user === null ? {} : { user }), targetType, targetDocumentId: target },
    });

  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: { MFA_REQUIRED_ROLES: "team_lead" } });
    const { engineering, sales } = t.fixtures.departments;
    const { member } = t.fixtures.users;
    await announcement("acked", {});
    await announcement("open", {});
    await announcement("sales", { audience: "departments", department: sales.documentId });
    await announcement("expired", { expiresAt: "2020-01-01T00:00:00.000Z" });
    await announcement("draftOnly", {}, "draft");
    await announcement("notMandatory", { requiresAck: false });
    // Published for Sales; the draft is company-wide since: the visible draft
    // row must not count the hidden publication.
    await announcement("twin", { audience: "departments", department: sales.documentId });
    await t.strapi.documents(ANNOUNCEMENT).update({
      documentId: ids.twin,
      data: { audience: "all", department: null },
    });
    await announcement("retarget", {});
    await bulk(ANNOUNCEMENT).updateMany({
      where: { documentId: ids.retarget },
      data: { retargetRequired: true },
    });
    await document("docAll", {});
    await document("docSales", { departments: [sales.documentId] });
    await document("docEngineering", { departments: [engineering.documentId] });
    await receipt(member.id, "announcement", ids.acked);
    await receipt(member.id, "announcement", ids.acked);
    // A receipt of the other type for the same documentId changes nothing.
    await receipt(member.id, "document", ids.open);
  });

  afterEach(() => {
    delete process.env.FEATURES_OFF;
  });

  afterAll(async () => {
    await t?.stop();
  });

  const counts = async (caller: Parameters<TestStrapi["api"]>[0]) => {
    const res = await t.api<Counts>(caller, "/api/me/open-acks");
    expect(res.status, res.text).toBe(200);
    return res.body.data;
  };

  it("counts the visible published mandatory items the caller has not confirmed", async () => {
    // open; not acked (confirmed), sales (Engineering caller), expired,
    // draftOnly, notMandatory, twin (hidden publication), retarget.
    expect(await counts("member")).toEqual({ announcements: 1, documents: 2 });
    expect(await counts("department_head")).toEqual({ announcements: 2, documents: 2 });
  });

  it("the moderators count every published mandatory row, expired and retargeted included", async () => {
    // acked, open, sales, expired, twin, retarget; every document.
    expect(await counts("editor")).toEqual({ announcements: 6, documents: 3 });
    expect(await counts("admin_role")).toEqual({ announcements: 6, documents: 3 });
  });

  it("a kind the role may not read is null, never 0", async () => {
    expect(await counts("guest")).toEqual({ announcements: null, documents: null });
    const before = await counts("authenticated");
    expect(before.announcements).toBe(2);
    const role = (await t.strapi.db
      .query(ROLE)
      .findOne({ where: { type: "authenticated" }, select: ["id"] })) as Row;
    await bulk(PERMISSION).deleteMany({
      where: { action: `${ANNOUNCEMENT}.find`, role: { id: role.id } },
    });
    expect(await counts("authenticated")).toEqual({
      announcements: null,
      documents: before.documents,
    });
  });

  it("read-confirmations off closes both routes", async () => {
    process.env.FEATURES_OFF = "read-confirmations";
    expect((await t.api("member", "/api/me/open-acks")).status).toBe(404);
    const index = await t.api("admin_role", "/api/acknowledgements/report-index", {
      json: { targetType: "announcement", documentIds: [ids.open] },
    });
    expect(index.status).toBe(404);
    expect((await t.api("member", "/api/me")).status).toBe(200);
  });

  it("a restricted, revoked, blocked or anonymous caller gets no count", async () => {
    // team_lead must enrol a second factor first: its session is restricted.
    expect((await t.api("team_lead", "/api/me/open-acks")).status).toBe(403);
    expect((await t.api(null, "/api/me/open-acks")).status).toBe(403);
    const head = t.fixtures.users.department_head;
    const jwt = await t.login(head.username, head.password);
    expect((await t.api({ jwt }, "/api/me/open-acks")).status).toBe(200);
    await t.strapi.db.query(USER).update({ where: { id: head.id }, data: { tokenVersion: 9 } });
    expect((await t.api({ jwt }, "/api/me/open-acks")).status).toBe(401);
    await t.strapi.db
      .query(USER)
      .update({ where: { id: head.id }, data: { tokenVersion: 0, blocked: true } });
    expect([401, 403]).toContain((await t.api({ jwt }, "/api/me/open-acks")).status);
    await t.strapi.db.query(USER).update({ where: { id: head.id }, data: { blocked: false } });
  });

  describe("POST /api/acknowledgements/report-index", () => {
    const post = (caller: Parameters<TestStrapi["api"]>[0], json: unknown) =>
      t.api<Index>(caller, "/api/acknowledgements/report-index", { json });

    it("answers admin_role who confirmed which item, deduplicated, by type", async () => {
      const { member, editor } = t.fixtures.users;
      await receipt(editor.id, "announcement", ids.acked);
      await receipt(null, "announcement", ids.acked);
      const res = await post("admin_role", {
        targetType: "announcement",
        documentIds: [ids.acked, ids.open, "zzzzzzzzzzzzzzzzzzzzzzzz"],
      });
      expect(res.status, res.text).toBe(200);
      expect(res.body).toEqual({
        data: {
          acks: {
            [ids.acked]: [member.id, editor.id].sort((a, b) => a - b),
            [ids.open]: [],
            zzzzzzzzzzzzzzzzzzzzzzzz: [],
          },
        },
        meta: { truncated: false },
      });
      const documents = await post("admin_role", {
        targetType: "document",
        documentIds: [ids.open],
      });
      expect(documents.body.data.acks).toEqual({ [ids.open]: [member.id] });
    });

    it("keeps a blocked person's receipt (the report's audience rules drop them)", async () => {
      const head = t.fixtures.users.department_head;
      await receipt(head.id, "document", ids.docAll);
      await t.strapi.db.query(USER).update({ where: { id: head.id }, data: { blocked: true } });
      const res = await post("admin_role", { targetType: "document", documentIds: [ids.docAll] });
      expect(res.body.data.acks[ids.docAll]).toEqual([head.id]);
      await t.strapi.db.query(USER).update({ where: { id: head.id }, data: { blocked: false } });
    });

    it("is admin_role's only, even for an editor holding the grant", async () => {
      const body = { targetType: "announcement", documentIds: [ids.open] };
      for (const caller of ["editor", "member", "guest"] as const) {
        expect((await post(caller, body)).status, caller).toBe(403);
      }
      const editorRole = (await t.strapi.db
        .query(ROLE)
        .findOne({ where: { type: "editor" }, select: ["id"] })) as Row;
      await t.strapi.db.query(PERMISSION).create({
        data: { action: `${ACK}.reportIndex`, role: editorRole.id },
      });
      expect((await post("editor", body)).status).toBe(403);
    });

    it("refuses more than 20 ids and a bad type", async () => {
      const many = Array.from({ length: 21 }, (_, i) => `doc${i}`);
      expect(
        (await post("admin_role", { targetType: "announcement", documentIds: many })).status,
      ).toBe(400);
      expect((await post("admin_role", { targetType: "poll", documentIds: [] })).status).toBe(400);
    });

    it("is complete at the budget and truncated one receipt past it", async () => {
      const doc = "capcapcapcapcapcapcapcap";
      const rows = Array.from({ length: 2_000 }, () => ({
        targetType: "document",
        targetDocumentId: doc,
      }));
      await bulk(ACK).createMany({ data: rows });
      const body = { targetType: "document", documentIds: [doc] };
      expect((await post("admin_role", body)).body.meta).toEqual({ truncated: false });
      await receipt(null, "document", doc);
      expect((await post("admin_role", body)).body.meta).toEqual({ truncated: true });
    });
  });
});
