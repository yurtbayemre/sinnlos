import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { errors } from "@strapi/utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_ENV, adminRequest, adminToken, createUser, signIn } from "./admin-api.test.helper";
import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";

/**
 * Secret shares never open in the admin panel (v0.35.0, plan §3.6), on both
 * engines:
 *   - after the boot no admin role holds any Content Manager grant on the
 *     type, read included, super admins too;
 *   - after a DELIBERATE re-grant of every Content Manager action on the
 *     type to the super admin role, every route family still refuses it,
 *     and each refusal is proved to come from the closure (a counter on the
 *     wrapped factory): list, detail, create, update, delete, bulk delete,
 *     clone, relations, the i18n fill-from-locale route and the preview over
 *     HTTP;
 *     history and the review-workflow entries (enterprise features, not
 *     mounted here) through their installed controllers. The share and its envelope are unchanged and
 *     no answer carries them.
 */

const UID = "api::secret-share.secret-share";
const ADMIN_PERMISSION = "admin::permission";
const CM = "plugin::content-manager.explorer";
const ACTIONS = ["read", "create", "update", "delete", "publish"].map((a) => `${CM}.${a}`);

/** An installed controller module: its actions (CommonJS, no default export). */
type Controller = Record<string, (ctx: unknown) => Promise<unknown>>;

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
    // Count every call of the wrapped factory and the wrapped preview for the
    // share's uid: each family must reach the closure, not stop before it.
    const contentManager = t.strapi.plugin("content-manager");
    const checker = contentManager.service("permission-checker") as {
      create(params: { model?: unknown }): unknown;
    };
    const preview = contentManager.service("preview") as {
      getPreviewUrl(uid: unknown, params: unknown): unknown;
    };
    let reached = 0;
    const create = checker.create.bind(checker);
    checker.create = (params) => {
      if (params?.model === UID) reached += 1;
      return create(params);
    };
    const getPreviewUrl = preview.getPreviewUrl.bind(preview);
    preview.getPreviewUrl = (uid, params) => {
      if (uid === UID) reached += 1;
      return getPreviewUrl(uid, params);
    };
    const base = `/content-manager/collection-types/${UID}`;
    const families: [string, string, string, unknown?][] = [
      ["list", "GET", base],
      ["detail", "GET", `${base}/${id}`],
      ["create", "POST", base, { senderId: 1, recipientId: 2, state: "pending" }],
      ["update", "PUT", `${base}/${id}`, { state: "revoked" }],
      ["delete", "DELETE", `${base}/${id}`],
      ["bulk delete", "POST", `${base}/actions/bulkDelete`, { documentIds: [id] }],
      ["clone", "POST", `${base}/clone/${id}`, {}],
      // The type's only relations are Strapi's createdBy/updatedBy.
      ["relations", "GET", `/content-manager/relations/${UID}/${id}/createdBy`],
      [
        "i18n fill-from-locale",
        "GET",
        `/i18n/content-manager/get-fill-from-locale/${UID}?documentId=${id}&sourceLocale=en&targetLocale=de&collectionType=collection-types`,
      ],
      ["preview", "GET", `/content-manager/preview/url/${UID}?documentId=${id}`],
    ];
    for (const [family, method, path, json] of families) {
      const before = reached;
      const res = await call(path, { method, json });
      expect(res.status, `${family}: ${res.text.slice(0, 200)}`).toBe(403);
      expect((res.body as { error?: { name?: string } }).error?.name, family).toBe(
        "ForbiddenError",
      );
      expect(reached, `${family} reached the closure`).toBeGreaterThan(before);
      expect(res.text, family).not.toContain(envelope);
      expect(res.text, family).not.toContain("ADMIN-SENTINEL-TEXT");
    }

    // History and review workflows are enterprise features: their HTTP
    // routes are not mounted here (404). Their installed controllers are
    // called directly instead, as a licensed instance would route them.
    expect(
      (await call(`/content-manager/history-versions?contentType=${UID}&documentId=${id}`)).status,
    ).toBe(404);
    expect(
      (await call(`/review-workflows/content-manager/collection-types/${UID}/${id}/stages`)).status,
    ).toBe(404);
    const strapiRequire = createRequire(
      createRequire(__filename).resolve("@strapi/strapi/package.json"),
    );
    const server = (pkg: string, file: string) =>
      createRequire(__filename)(
        join(dirname(strapiRequire.resolve(`${pkg}/package.json`)), "dist", "server", file),
      );
    const history = (
      server("@strapi/content-manager", "history/controllers/history-version.js") as {
        createHistoryVersionController(p: { strapi: unknown }): {
          findMany(ctx: unknown): Promise<unknown>;
        };
      }
    ).createHistoryVersionController({ strapi: t.strapi });
    const stages = server("@strapi/review-workflows", "controllers/stages.js") as Controller;
    const assignees = server("@strapi/review-workflows", "controllers/assignees.js") as Controller;
    const ctx = () => ({
      params: { model_uid: UID, id },
      query: { contentType: UID, documentId: id },
      request: { query: {}, body: { data: { id: 1 } } },
      state: { userAbility: {} },
      throw: (status: number) => {
        throw new Error(`ctx.throw ${status}`);
      },
      forbidden: () => {
        throw new Error("ctx.forbidden");
      },
    });
    for (const [family, run] of [
      ["history", () => history.findMany(ctx())],
      ["workflow stage update", () => stages.updateEntity(ctx())],
      ["workflow stages", () => stages.listAvailableStages(ctx())],
      ["workflow assignee", () => assignees.updateEntity(ctx())],
    ] as const) {
      const before = reached;
      await expect(run(), family).rejects.toBeInstanceOf(errors.ForbiddenError);
      expect(reached, `${family} reached the closure`).toBeGreaterThan(before);
    }
    const row = (await t.strapi.db.query(UID).findOne({ where: { documentId: id } })) as Row;
    expect(row.state).toBe("pending");
    expect(row.envelope).toBe(envelope);
    expect(await t.strapi.db.query(UID).count()).toBe(1);
    void engine;
  });
});
