import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_ENV, adminRequest, adminToken, createUser, signIn } from "./admin-api.test.helper";
import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";

/**
 * Secret shares never open in the admin panel (v0.35.0, plan §3.6), on both
 * engines:
 *   - after the boot no admin role holds any Content Manager grant on the
 *     type, read included, super admins too;
 *   - after a DELIBERATE re-grant of every Content Manager action on the
 *     type to the super admin role, every route family still refuses it:
 *     list, detail, create, update, delete, bulk actions, relations,
 *     history, the i18n fill-from-locale route, the review-workflow entries
 *     and the preview. The share and its envelope are unchanged and no
 *     answer carries them.
 */

const UID = "api::secret-share.secret-share";
const ADMIN_PERMISSION = "admin::permission";
const CM = "plugin::content-manager.explorer";
const ACTIONS = ["read", "create", "update", "delete", "publish"].map((a) => `${CM}.${a}`);

interface PermissionService {
  createMany(permissions: Record<string, unknown>[]): Promise<unknown>;
}

describe.each(testEngines())("secret shares in the admin panel on %s", (engine) => {
  let t: TestStrapi;
  let token: string;
  let id: string;
  let envelope: string;

  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: ADMIN_ENV });
    token = await adminToken(t);
    const sender = await createUser(t, "member");
    const recipient = await createUser(t, "member");
    const res = await t.api<{ data?: { id?: string } }>(
      { jwt: await signIn(t, sender) },
      "/api/secret-shares",
      { json: { recipient: recipient.id, text: "ADMIN-SENTINEL-TEXT", lifetime: "24h" } },
    );
    expect(res.status, res.text).toBe(201);
    id = res.body.data!.id!;
    envelope = String(
      ((await t.strapi.db.query(UID).findOne({ where: { documentId: id } })) as Row).envelope,
    );
  });
  afterAll(async () => {
    await t?.stop();
  });

  const call = (path: string, init: { method?: string; json?: unknown } = {}) =>
    adminRequest(t, token, path, init);

  it("leaves no admin role a Content Manager grant on the type after the boot", async () => {
    expect(await t.strapi.db.query(ADMIN_PERMISSION).count({ where: { subject: UID } })).toBe(0);
  });

  it("refuses every Content Manager route family after a deliberate re-grant", async () => {
    const before = await call(`/content-manager/collection-types/${UID}`);
    // Without a grant the panel's own policy refuses (PolicyError).
    expect(before.status).toBe(403);
    expect((before.body as { error?: { name?: string } }).error?.name).toBe("PolicyError");
    const superAdmin = (await t.strapi.db
      .query("admin::role")
      .findOne({ where: { code: "strapi-super-admin" } })) as Row;
    const permissions = (
      t.strapi as unknown as { admin: { services: { permission: PermissionService } } }
    ).admin.services.permission;
    await permissions.createMany(
      ACTIONS.map((action) => ({
        action,
        subject: UID,
        properties: {
          fields: ["senderId", "recipientId", "expiresAt", "state", "terminalAt", "envelope"],
        },
        conditions: [],
        role: superAdmin.id,
      })),
    );
    expect(await t.strapi.db.query(ADMIN_PERMISSION).count({ where: { subject: UID } })).toBe(
      ACTIONS.length,
    );
    const base = `/content-manager/collection-types/${UID}`;
    const routes: [string, string, unknown?][] = [
      ["GET", base],
      ["GET", `${base}/${id}`],
      ["POST", base, { senderId: 1, recipientId: 2, state: "pending" }],
      ["PUT", `${base}/${id}`, { state: "pending" }],
      ["DELETE", `${base}/${id}`],
      ["POST", `${base}/actions/bulkDelete`, { documentIds: [id] }],
      ["GET", `${base}/actions/countManyEntriesDraftRelations?documentIds[0]=${id}`],
      ["GET", `${base}/${id}/actions/countDraftRelations`],
      ["POST", `${base}/clone/${id}`, {}],
      ["GET", `/content-manager/relations/${UID}/${id}/senderId`],
      ["GET", `/content-manager/history-versions?contentType=${UID}&documentId=${id}`],
      [
        "GET",
        `/i18n/content-manager/get-fill-from-locale/${UID}?documentId=${id}&sourceLocale=en&targetLocale=de`,
      ],
      [
        "PUT",
        `/review-workflows/content-manager/collection-types/${UID}/${id}/stage`,
        { data: { id: 1 } },
      ],
      ["GET", `/review-workflows/content-manager/collection-types/${UID}/${id}/stages`],
      ["GET", `/content-manager/preview/url/${UID}?documentId=${id}`],
    ];
    for (const [method, path, json] of routes) {
      const res = await call(path, { method, json });
      expect(res.status, `${method} ${path}: ${res.text.slice(0, 200)}`).toBeGreaterThanOrEqual(
        400,
      );
      expect(res.text, path).not.toContain(envelope);
      expect(res.text, path).not.toContain("ADMIN-SENTINEL-TEXT");
      expect(res.text, path).not.toContain('"recipientId"');
    }
    // The re-grant passes the panel's own policies: the 403 is the closure's
    // ForbiddenError, not a "Policy Failed" of a missing grant.
    for (const path of [
      base,
      `${base}/${id}`,
      `/content-manager/preview/url/${UID}?documentId=${id}`,
    ]) {
      const res = await call(path);
      expect(res.status, path).toBe(403);
      expect((res.body as { error?: { name?: string } }).error?.name, path).toBe("ForbiddenError");
    }
    const row = (await t.strapi.db.query(UID).findOne({ where: { documentId: id } })) as Row;
    expect(row.state).toBe("pending");
    expect(row.envelope).toBe(envelope);
    expect(await t.strapi.db.query(UID).count()).toBe(1);
    void engine;
  });
});
