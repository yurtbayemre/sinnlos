import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  bumpTokenVersion,
  currentTokenVersion,
  type TokenVersionStrapi,
} from "../extensions/users-permissions/strapi-server";
import {
  createTestStrapi,
  testEngines,
  type TestStrapi,
  type TestUser,
} from "./harness.test.helper";

/**
 * A password change revokes the user's older JWTs (FX40) on the real cms:
 * the users-permissions extension (src/extensions/users-permissions/
 * strapi-server.ts) with the plugin's own auth controller, strategy and
 * jwt service, over HTTP.
 *
 *   1. JWTs carry the user's token version (claim `tv`); a JWT without it
 *      (every JWT from before this change) is version 0 and stays valid, so
 *      the deploy signs nobody out;
 *   2. POST /api/auth/change-password bumps the version: every older JWT
 *      of that user gets 401, the JWT in its answer and a new sign-in work,
 *      and other users' JWTs stay valid;
 *   3. a refused change (wrong current password) revokes nothing;
 *   4. the version is private: not in any answer, not filterable;
 *   5. the bump is atomic on the real database: overlapping bumps of one
 *      user each commit their own version, none is lost, and overlapping
 *      changes each answer with their own version;
 *   6. it fails closed: a failed bump saves nothing, a failed save after
 *      the bump leaves the old password with the older JWTs revoked.
 */

/** A JWT signed like the plugin's legacy issue() did before FX40: no `tv`. */
function legacyJwt(secret: string, id: number): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ id, iat: now, exp: now + 3600 })}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

const claims = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;

describe.each(testEngines())("password change revokes older JWTs (FX40) on %s", (engine) => {
  let t: TestStrapi;
  let user: TestUser;
  let secret: string;

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    user = t.fixtures.users.team_lead;
    secret = String(t.strapi.config.get("plugin::users-permissions.jwtSecret"));
  });

  afterAll(async () => {
    await t?.stop();
  });

  const me = (jwt: string) => t.api<Record<string, unknown>>({ jwt }, "/api/users/me");
  const changePassword = (jwt: string, currentPassword: string, password: string) =>
    t.api<{ jwt?: string; user?: Record<string, unknown> }>({ jwt }, "/api/auth/change-password", {
      json: { currentPassword, password, passwordConfirmation: password },
    });

  it("revokes every older JWT and hands out a current one", async () => {
    // Before: a sign-in's JWT carries version 0, and a JWT without the claim
    // (issued before this change) is version 0 too.
    const signedIn = await t.login(user.username, user.password);
    expect(claims(signedIn).tv).toBe(0);
    const legacy = legacyJwt(secret, user.id);
    expect((await me(signedIn)).status).toBe(200);
    expect((await me(legacy)).status).toBe(200);
    const other = await t.loginAs("editor");

    // A refused change revokes nothing.
    const refused = await changePassword(signedIn, "not-the-password", "Another-Pass-123");
    expect(refused.status).toBe(400);
    expect((await me(signedIn)).status).toBe(200);

    const newPassword = "Brand-New-Pass-456";
    const changed = await changePassword(signedIn, user.password, newPassword);
    expect(changed.status).toBe(200);
    const current = changed.body.jwt ?? "";
    expect(claims(current)).toMatchObject({ id: user.id, tv: 1 });
    // The version never leaves the cms.
    expect(changed.body.user).not.toHaveProperty("tokenVersion");

    // Every older JWT of this user: 401.
    for (const old of [signedIn, legacy]) {
      const res = await me(old);
      expect(res.status).toBe(401);
    }
    // The JWT of the answer, and a new sign-in, work.
    const answer = await me(current);
    expect(answer.status).toBe(200);
    expect(answer.body).not.toHaveProperty("tokenVersion");
    const again = await t.login(user.username, newPassword);
    expect(claims(again).tv).toBe(1);
    expect((await me(again)).status).toBe(200);
    // Somebody else is not affected.
    expect((await me(other)).status).toBe(200);

    const row = await t.strapi.db
      .query("plugin::users-permissions.user")
      .findOne({ where: { id: user.id }, select: ["id", "tokenVersion"] });
    expect(row?.tokenVersion).toBe(1);
  });

  it("treats a stored NULL like 0 (a column added without its default)", async () => {
    const guest = t.fixtures.users.guest;
    await t.strapi.db
      .query("plugin::users-permissions.user")
      .update({ where: { id: guest.id }, data: { tokenVersion: null } });
    expect((await me(legacyJwt(secret, guest.id))).status).toBe(200);
  });

  it("raises the version atomically: 20 overlapping bumps commit 20 versions (5 runs)", async () => {
    const strapi = t.strapi as unknown as TokenVersionStrapi;
    const id = t.fixtures.users.member.id;
    for (let run = 0; run < 5; run += 1) {
      const start = (await currentTokenVersion(strapi, id)) ?? 0;
      const versions = await Promise.all(
        Array.from({ length: 20 }, () => bumpTokenVersion(strapi, id)),
      );
      // Each bump got a version of its own, and the stored one is the last.
      expect([...versions].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 20 }, (_, i) => start + i + 1),
      );
      expect(await currentTokenVersion(strapi, id)).toBe(start + 20);
    }
  });

  it("answers each of overlapping password changes with its own version; only the last survives (3 runs)", async () => {
    const strapi = t.strapi as unknown as TokenVersionStrapi;
    const account = t.fixtures.users.department_head;
    let password = account.password;
    for (let run = 1; run <= 3; run += 1) {
      const start = (await currentTokenVersion(strapi, account.id)) ?? 0;
      const signedIn = await t.login(account.username, password);
      // Four tabs of the user change the password at the same time, to the
      // same new one: a change whose hash read came after another's write
      // is refused (400), a request that arrives after another's bump is
      // unauthenticated (401). Whatever the interleaving:
      const next = `Parallel-Pass-${run}-789`;
      const answers = await Promise.all(
        Array.from({ length: 4 }, () => changePassword(signedIn, password, next)),
      );
      for (const answer of answers) expect([200, 400, 401]).toContain(answer.status);
      const issued = answers
        .filter((answer) => answer.status === 200)
        .map((answer) => answer.body.jwt ?? "");
      expect(issued.length).toBeGreaterThan(0);
      // every successful change committed a version of its own and answered
      // with exactly that one,
      const versions = issued.map((jwt) => claims(jwt).tv as number).sort((a, b) => a - b);
      expect(versions).toEqual(Array.from({ length: issued.length }, (_, i) => start + i + 1));
      expect(await currentTokenVersion(strapi, account.id)).toBe(start + issued.length);
      // and only the JWT of the last bump is accepted.
      const last = start + issued.length;
      for (const jwt of issued) {
        expect((await me(jwt)).status).toBe(claims(jwt).tv === last ? 200 : 401);
      }
      expect((await me(signedIn)).status).toBe(401);
      password = next;
    }
    expect((await me(await t.login(account.username, password))).status).toBe(200);
  });

  describe("fails closed when the bump or the save fails (the real controller and Document Service)", () => {
    // The fixture user of the one role no other test here signs in as.
    const account = () => t.fixtures.users.authenticated;
    let failSave = false;
    let middlewareAdded = false;

    /** A Document Service middleware that fails the save of a password while `failSave`. */
    const ensureSaveFault = () => {
      if (middlewareAdded) return;
      middlewareAdded = true;
      const documents = t.strapi.documents as unknown as {
        use(
          middleware: (
            context: { uid: string; action: string; params?: { data?: object } },
            next: () => Promise<unknown>,
          ) => Promise<unknown>,
        ): void;
      };
      documents.use(async (context, next) => {
        const data = context.params?.data;
        if (
          failSave &&
          context.uid === "plugin::users-permissions.user" &&
          context.action === "update" &&
          data !== undefined &&
          "password" in data
        ) {
          throw new Error("the save of the password failed");
        }
        return next();
      });
    };

    afterEach(() => {
      vi.restoreAllMocks();
      failSave = false;
    });

    it("a failed bump answers an error and leaves the password and the sessions as they were", async () => {
      const strapi = t.strapi as unknown as TokenVersionStrapi;
      const connection = strapi.db.connection as { raw(sql: string, b: unknown[]): unknown };
      const raw = connection.raw.bind(connection);
      vi.spyOn(connection, "raw").mockImplementation((sql: string, bindings: unknown[]) => {
        if (/^UPDATE\b/.test(sql) && sql.includes("token_version")) {
          return Promise.reject(new Error("connection lost"));
        }
        return raw(sql, bindings);
      });
      const { username, password, id } = account();
      const signedIn = await t.login(username, password);
      const start = await currentTokenVersion(strapi, id);
      const failed = await changePassword(signedIn, password, "Never-Saved-Pass-1");
      expect(failed.status).toBe(500);
      expect(failed.body).not.toHaveProperty("jwt");
      vi.restoreAllMocks();
      // Not saved: the old password signs in, the new one does not.
      await expect(t.login(username, "Never-Saved-Pass-1")).rejects.toThrow("failed: 400");
      const again = await t.login(username, password);
      expect(await currentTokenVersion(strapi, id)).toBe(start);
      for (const jwt of [signedIn, again]) expect((await me(jwt)).status).toBe(200);
    });

    it("a failed save after the bump answers an error: old password, every older JWT revoked", async () => {
      ensureSaveFault();
      const strapi = t.strapi as unknown as TokenVersionStrapi;
      const { username, password, id } = account();
      const signedIn = await t.login(username, password);
      const start = (await currentTokenVersion(strapi, id)) ?? 0;
      failSave = true;
      const failed = await changePassword(signedIn, password, "Never-Saved-Pass-2");
      failSave = false;
      expect(failed.status).toBe(500);
      expect(failed.body).not.toHaveProperty("jwt");
      expect(await currentTokenVersion(strapi, id)).toBe(start + 1);
      // The sessions are signed out; the old password signs in again.
      expect((await me(signedIn)).status).toBe(401);
      await expect(t.login(username, "Never-Saved-Pass-2")).rejects.toThrow("failed: 400");
      const again = await t.login(username, password);
      expect(claims(again).tv).toBe(start + 1);
      expect((await me(again)).status).toBe(200);
    });
  });

  it("keeps the version private: not filterable through the API", async () => {
    const admin = await t.loginAs("admin_role");
    const res = await t.api({ jwt: admin }, "/api/users?filters[tokenVersion][$eq]=1");
    expect(res.status).toBe(400);
  });
});
