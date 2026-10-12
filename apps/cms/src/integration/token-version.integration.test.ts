import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
 *   4. the version is private: not in any answer, not filterable.
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

  it("keeps the version private: not filterable through the API", async () => {
    const admin = await t.loginAs("admin_role");
    const res = await t.api({ jwt: admin }, "/api/users?filters[tokenVersion][$eq]=1");
    expect(res.status).toBe(400);
  });
});
