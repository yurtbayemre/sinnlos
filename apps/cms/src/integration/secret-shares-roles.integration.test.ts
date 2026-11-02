import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { secretRoles, type SecretRoles } from "@sinnlos/domain";

import { createUser, signIn, type CreatedUser } from "./admin-api.test.helper";
import {
  createTestDatabase,
  createTestStrapi,
  testEngines,
  type ApiResponse,
  type Caller,
  type Row,
  type TestRole,
  type TestStrapi,
} from "./harness.test.helper";
import { holdTransaction, qualified, settle, waitForLockWait } from "./pg-lock.test.helper";

/**
 * Secret sharing by role (v0.36.0, docs/plan-secret-sharing-by-role.md
 * §2.2 and §4.3) against the real cms, on SQLite and Postgres 16. The suite
 * boots with SECRETS_SEND_ROLES=department_head,team_lead (the owner's
 * example); a case that needs other lists sets them in this process through
 * configureSecretRoles, as register() does at boot, and the next case gets
 * the boot lists back. The restart cases boot with their lists in the env.
 * With both lists unset every v0.35 suite runs unchanged (the harness
 * clears them).
 */

const UID = "api::secret-share.secret-share";
const NOTIFICATION = "api::notification.notification";
const USER = "plugin::users-permissions.user";
const ROLE = "plugin::users-permissions.role";
const BOOT_ENV = { SECRETS_SEND_ROLES: "department_head,team_lead" };

type Body = {
  data?: Record<string, unknown> & {
    id?: string;
    text?: string;
    available?: boolean;
    received?: Record<string, unknown>[];
    sent?: Record<string, unknown>[];
  };
  error?: { details?: { code?: string } };
};

interface SharesModule {
  __resetCreateLimiterForTest(): void;
  configureSecretRoles(roles: SecretRoles): void;
  createShare(strapi: unknown, caller: unknown, input: unknown): Promise<unknown>;
  revealShare(strapi: unknown, caller: unknown, id: string): Promise<string>;
}

describe.each(testEngines())("secret sharing by role on %s", (engine) => {
  let t: TestStrapi;
  let shares: SharesModule;

  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: BOOT_ENV });
    shares = t.requireBuilt<SharesModule>("src/utils/secret-shares");
  });
  afterAll(async () => {
    await t?.stop();
  });
  beforeEach(() => shares.__resetCreateLimiterForTest());
  afterEach(() => shares.configureSecretRoles(secretRoles(BOOT_ENV)));

  /** The lists of a boot with `env` (what register() reads). */
  const lists = (env: Record<string, string>) => shares.configureSecretRoles(secretRoles(env));
  const api = (caller: Caller, path: string, init?: Parameters<TestStrapi["api"]>[2]) =>
    t.api<Body>(caller, path, init) as Promise<ApiResponse<Body>>;
  const as = async (user: CreatedUser): Promise<Caller> => ({ jwt: await signIn(t, user) });
  const create = (caller: Caller, recipient: number) =>
    api(caller, "/api/secret-shares", { json: { recipient, text: "hunter2", lifetime: "1h" } });
  const reveal = (caller: Caller, id: string) =>
    api(caller, `/api/secret-shares/${id}/reveal`, { method: "POST" });
  const code = (res: ApiResponse<Body>) => res.body?.error?.details?.code;
  const stored = async (documentId: string) =>
    (await t.strapi.db.query(UID).findOne({ where: { documentId } })) as Row | null;
  const notified = (recipientId: number) =>
    t.strapi.db.query(NOTIFICATION).count({
      where: { type: "secretShared", recipient: { id: recipientId } },
    });
  const sentBy = (senderId: number) => t.strapi.db.query(UID).count({ where: { senderId } });

  async function person(role: TestRole) {
    const user = await createUser(t, role);
    return { user, caller: await as(user) };
  }

  /** A pending share from a team lead to `recipientRole`. */
  async function shared(recipientRole: TestRole = "member") {
    const lead = await person("team_lead");
    const to = await person(recipientRole);
    const res = await create(lead.caller, to.user.id);
    expect(res.status, res.text).toBe(201);
    return { lead, to, id: res.body.data!.id as string };
  }

  /** `available` of the share in the list and the detail, for sender and recipient. */
  async function availability(lead: Caller, to: Caller, id: string) {
    const sent = (await api(lead, "/api/secret-shares")).body.data!.sent!;
    const received = (await api(to, "/api/secret-shares")).body.data!.received!;
    return {
      senderList: sent.find((share) => share.id === id)?.available,
      senderDetail: (await api(lead, `/api/secret-shares/${id}`)).body.data!.available,
      recipientList: received.find((share) => share.id === id)?.available ?? "absent",
      recipientDetail: (await api(to, `/api/secret-shares/${id}`)).body.data!.available,
    };
  }

  describe("create", () => {
    it("a caller outside the send list gets a plain 403, and nothing is written", async () => {
      const member = await person("member");
      const to = await person("member");
      const res = await create(member.caller, to.user.id);
      expect(res.status, res.text).toBe(403);
      expect(code(res)).toBeUndefined();
      expect(await sentBy(member.user.id)).toBe(0);
      expect(await notified(to.user.id)).toBe(0);
    });

    it("a recipient outside the receive list gets 400 recipient, and nothing is written", async () => {
      lists({ ...BOOT_ENV, SECRETS_RECEIVE_ROLES: "department_head,team_lead" });
      const lead = await person("team_lead");
      const to = await person("member");
      const res = await create(lead.caller, to.user.id);
      expect(res.status, res.text).toBe(400);
      expect(code(res)).toBe("recipient");
      expect(await sentBy(lead.user.id)).toBe(0);
      expect(await notified(to.user.id)).toBe(0);
      // A recipient in the list gets it.
      const head = await person("department_head");
      expect((await create(lead.caller, head.user.id)).status).toBe(201);
    });
  });

  describe("recipient search", () => {
    it("a caller who may not send gets a plain 403", async () => {
      const member = await person("member");
      const res = await api(member.caller, "/api/secret-shares/recipients?q=a");
      expect(res.status, res.text).toBe(403);
      expect(code(res)).toBeUndefined();
    });

    it("filters by the receive list before the limit: 20 excluded names first, the match still comes", async () => {
      const prefix = `rolesearch${randomBytes(4).toString("hex")}`;
      const rename = (id: number, displayName: string) =>
        t.strapi.db.query(USER).update({ where: { id }, data: { displayName } });
      for (let i = 0; i < 21; i += 1) {
        const member = await createUser(t, "member");
        await rename(member.id, `${prefix} a ${String(i).padStart(2, "0")}`);
      }
      const head = await createUser(t, "department_head");
      await rename(head.id, `${prefix} b`);
      const lead = await person("team_lead");
      const search = async () => {
        const res = await api(lead.caller, `/api/secret-shares/recipients?q=${prefix}`);
        expect(res.status, res.text).toBe(200);
        return (res.body.data as unknown as { id: number }[]).map((row) => row.id);
      };
      // All staff: the 20 members fill the page, the department head is cut.
      const all = await search();
      expect(all).toHaveLength(20);
      expect(all).not.toContain(head.id);
      lists({ ...BOOT_ENV, SECRETS_RECEIVE_ROLES: "department_head" });
      expect(await search()).toEqual([head.id]);
    });
  });

  describe("reveal and the lists", () => {
    it("a recipient taken off the receive list gets 403, keeps the share pending, and opens it with the role back", async () => {
      const { lead, to, id } = await shared();
      expect(await availability(lead.caller, to.caller, id)).toEqual({
        senderList: true,
        senderDetail: true,
        recipientList: true,
        recipientDetail: true,
      });
      lists({ ...BOOT_ENV, SECRETS_RECEIVE_ROLES: "department_head,team_lead" });
      const res = await reveal(to.caller, id);
      expect(res.status, res.text).toBe(403);
      expect(code(res)).toBeUndefined();
      expect(res.text).not.toContain("hunter2");
      expect((await stored(id))?.state).toBe("pending");
      expect(await notified(to.user.id)).toBe(1);
      // The same `available` in list and detail, on both sides; the inbox is empty.
      expect(await availability(lead.caller, to.caller, id)).toEqual({
        senderList: false,
        senderDetail: false,
        recipientList: "absent",
        recipientDetail: false,
      });
      expect((await api(to.caller, "/api/secret-shares")).body.data!.received).toEqual([]);
      lists(BOOT_ENV);
      const opened = await reveal(to.caller, id);
      expect(opened.status, opened.text).toBe(200);
      expect(opened.body.data!.text).toBe("hunter2");
    });

    it("a share opens after its sender lost the send right (D5)", async () => {
      const { lead, to, id } = await shared();
      lists({ SECRETS_SEND_ROLES: "department_head" });
      expect(await availability(lead.caller, to.caller, id)).toEqual({
        senderList: true,
        senderDetail: true,
        recipientList: true,
        recipientDetail: true,
      });
      const res = await reveal(to.caller, id);
      expect(res.status, res.text).toBe(200);
      expect(res.body.data!.text).toBe("hunter2");
    });

    it("a sender without the send right still revokes", async () => {
      const { lead, id } = await shared();
      lists({ SECRETS_SEND_ROLES: "department_head" });
      const res = await api(lead.caller, `/api/secret-shares/${id}/revoke`, { method: "POST" });
      expect(res.status, res.text).toBe(200);
      expect((await stored(id))?.state).toBe("revoked");
    });

    it("the janitor leaves a share alone while its recipient is outside the receive list", async () => {
      const { to, id } = await shared();
      lists({ ...BOOT_ENV, SECRETS_RECEIVE_ROLES: "team_lead" });
      const janitor = t.requireBuilt<{ runSecretShareJanitor(s: unknown): Promise<unknown> }>(
        "src/cron/secret-share-janitor",
      );
      await janitor.runSecretShareJanitor(t.strapi);
      expect((await stored(id))?.state).toBe("pending");
      expect(await notified(to.user.id)).toBe(1);
    });
  });

  describe("a role change while the request waits for the locks", () => {
    const tokenVersion = async (id: number) =>
      Number(
        (
          (await t.strapi.db
            .query(USER)
            .findOne({ where: { id }, select: ["tokenVersion"] })) as Row
        ).tokenVersion ?? 0,
      );
    /** The caller as its password request was verified. */
    const verified = async (userId: number) => ({
      userId,
      assurance: { am: "pw", mfa: false, tv: await tokenVersion(userId), restricted: false },
    });
    const pool = () =>
      (
        t.strapi.db as unknown as {
          connection: { client: { pool: { numPendingAcquires(): number } } };
        }
      ).connection.client.pool;
    type Probe = { raw(sql: string, b?: unknown[]): Promise<unknown>; commit(): Promise<unknown> };

    /**
     * Starts `request`, waits until it queues (SQLite: behind the one
     * connection; Postgres: behind the directory lock), moves `userId` to
     * `role` in the transaction it waits for, then lets it go.
     */
    async function roleChangedWhileQueued<T>(
      request: () => Promise<T>,
      userId: number,
      role: TestRole,
    ) {
      const roleId = ((await t.strapi.db.query(ROLE).findOne({ where: { type: role } })) as Row).id;
      const probe: Probe =
        engine === "sqlite"
          ? await (
              t.strapi.db as unknown as { connection: { transaction(): Promise<Probe> } }
            ).connection.transaction()
          : await holdTransaction(t);
      let pending: ReturnType<typeof settle<T>>;
      try {
        if (engine === "postgres") {
          await probe.raw(
            `SELECT 1 FROM ${qualified(t, "content_versions")} WHERE target_uid = ? AND target_document_id = ? FOR UPDATE`,
            ["sinnlos::user-directory", "global"],
          );
        }
        pending = settle(request());
        if (engine === "sqlite") {
          await expect
            .poll(() => pool().numPendingAcquires(), { timeout: 10_000 })
            .toBeGreaterThan(0);
        } else {
          await waitForLockWait(t);
        }
        const link =
          engine === "sqlite" ? '"up_users_role_lnk"' : qualified(t, "up_users_role_lnk");
        await probe.raw(`UPDATE ${link} SET "role_id" = ? WHERE "user_id" = ?`, [roleId, userId]);
      } finally {
        await probe.commit();
      }
      return pending!;
    }
    /** A ForbiddenError without a code is the plain 403 over HTTP. */
    const refusal = (outcome: { ok: boolean; error?: unknown }) => {
      expect(outcome.ok).toBe(false);
      const err = outcome.error as { name?: string; details?: { code?: string } };
      return { name: err.name, code: err.details?.code };
    };

    it("a sender demoted out of the send list while create waits gets 403; nothing is written", async () => {
      const lead = await createUser(t, "team_lead");
      const to = await createUser(t, "member");
      const caller = await verified(lead.id);
      const outcome = await roleChangedWhileQueued(
        () => shares.createShare(t.strapi, caller, { recipient: to.id, text: "x", lifetime: "1h" }),
        lead.id,
        "member",
      );
      expect(refusal(outcome)).toEqual({ name: "ForbiddenError", code: undefined });
      expect(await sentBy(lead.id)).toBe(0);
      expect(await notified(to.id)).toBe(0);
    });

    it("a recipient demoted out of the receive list while reveal waits gets 403; the share stays pending", async () => {
      lists({ ...BOOT_ENV, SECRETS_RECEIVE_ROLES: "team_lead" });
      const { to, id } = await shared("team_lead");
      const caller = await verified(to.user.id);
      const outcome = await roleChangedWhileQueued(
        () => shares.revealShare(t.strapi, caller, id),
        to.user.id,
        "member",
      );
      expect(refusal(outcome)).toEqual({ name: "ForbiddenError", code: undefined });
      expect((await stored(id))?.state).toBe("pending");
    });
  });
});

describe.each(testEngines())("secret-sharing role lists at boot on %s", (engine) => {
  it("a bad list refuses the boot, naming the key", async () => {
    await expect(
      createTestStrapi({ engine, env: { SECRETS_RECEIVE_ROLES: "member,guest" } }),
    ).rejects.toThrow(/SECRETS_RECEIVE_ROLES: "guest" is not a staff role/);
  });

  it("the lists are read at boot: refused under one, opened after a restart with the role back", async () => {
    const database = await createTestDatabase(engine);
    // One key for both boots, so the envelope opens after the restart.
    const ENCRYPTION_KEY = randomBytes(24).toString("base64url");
    let documentId = "";
    let recipient: CreatedUser | undefined;
    try {
      const first = await createTestStrapi({
        database,
        env: { ENCRYPTION_KEY, SECRETS_RECEIVE_ROLES: "team_lead" },
      });
      try {
        const lead = await createUser(first, "team_lead");
        const to = await createUser(first, "team_lead");
        const res = await first.api<{ data?: { id?: string } }>(
          { jwt: await signIn(first, lead) },
          "/api/secret-shares",
          { json: { recipient: to.id, text: "after restart", lifetime: "24h" } },
        );
        expect(res.status, res.text).toBe(201);
        documentId = res.body.data!.id as string;
        recipient = to;
        // Now a member: outside this boot's receive list.
        const member = (await first.strapi.db
          .query(ROLE)
          .findOne({ where: { type: "member" } })) as Row;
        await first.strapi.db
          .query(USER)
          .update({ where: { id: to.id }, data: { role: member.id } });
        const refused = await first.api(
          { jwt: await signIn(first, to) },
          `/api/secret-shares/${documentId}/reveal`,
          { method: "POST" },
        );
        expect(refused.status, refused.text).toBe(403);
      } finally {
        await first.stop();
      }
      const second = await createTestStrapi({
        database,
        fixtures: false,
        env: { ENCRYPTION_KEY, SECRETS_RECEIVE_ROLES: "team_lead,member" },
      });
      try {
        const jwt = await signIn(second, recipient!);
        const opened = await second.api<Body>({ jwt }, `/api/secret-shares/${documentId}/reveal`, {
          method: "POST",
        });
        expect(opened.status, opened.text).toBe(200);
        expect(opened.body.data!.text).toBe("after restart");
      } finally {
        await second.stop();
      }
    } finally {
      await database.drop();
    }
  }, 180_000);
});
