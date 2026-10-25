/**
 * v0.27 "accounts" (deep-dive plan-v027-rev2.md + rev3) against the real
 * cms: the per-request second-factor gate, sign-in with TOTP and recovery
 * codes, enrollment, disable, the admin reset, set-password links
 * (invitations, resets, forgot) and the password baseline. Time steps are
 * moved with a faked Date (the cms runs in this process).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ErrorBody } from "./authoring.test.helper";
import {
  createTestStrapi,
  testEngines,
  type ApiResponse,
  type Row,
  type TestStrapi,
} from "./harness.test.helper";
import {
  holdTransaction,
  qualified,
  settle,
  testSchema,
  waitForLockWait,
} from "./pg-lock.test.helper";

const USER = "plugin::users-permissions.user";
const TOKEN = "integration-internal-token-0123456789";
const STEP_MS = 30_000;

interface Totp {
  hotp(secret: Buffer, counter: number): string;
  base32Decode(input: string): Buffer | null;
  totpStep(atMs?: number): number;
}

type Answer<T = Record<string, unknown>> = ApiResponse<
  { data?: T; jwt?: string } & {
    error?: ErrorBody["error"] & { details?: { code?: string } };
  }
>;

describe.each(testEngines())("accounts (v0.27) on %s", (engine) => {
  let t: TestStrapi;
  let totp: Totp;
  let mfa: { hashRecoveryCode(code: string): string };
  const mails: { to: string; subject: string; text: string }[] = [];

  beforeAll(async () => {
    t = await createTestStrapi({
      engine,
      env: {
        MFA_REQUIRED_ROLES: "admin_role,editor",
        INTERNAL_UPLOAD_TOKEN: TOKEN,
        SMTP_HOST: "smtp.integration.invalid",
        SMTP_USER: "user",
        SMTP_PASS: "pass",
        DIGEST_FROM: "Intranet <noreply@integration.test>",
        PUBLIC_WEB_URL: "https://intranet.integration.test",
      },
    });
    totp = t.requireBuilt<Totp>("src/utils/totp");
    mfa = t.requireBuilt<{ hashRecoveryCode(code: string): string }>("src/utils/mfa-core");
    const email = t.strapi.plugin("email").service("email") as unknown as {
      send(mail: { to: string; subject: string; text: string }): Promise<void>;
    };
    email.send = async (mail) => {
      mails.push(mail);
    };
    // Date only, running with real time; later() jumps it forward, never back.
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  });
  afterAll(async () => {
    vi.useRealTimers();
    await t?.stop();
  });

  /** Moves the cms's clock (Date only) forward by whole time steps. */
  const later = (steps: number) => {
    vi.setSystemTime(Date.now() + steps * STEP_MS);
  };
  /** The claims of a JWT (not verified: the cms verifies). */
  const claimsOf = (jwt: string) =>
    JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;

  const bearer = (jwt: string) => ({ jwt });
  const signIn = (identifier: string, password: string, otp?: string) =>
    t.api(null, "/api/auth/local", {
      json: { identifier, password, ...(otp === undefined ? {} : { otp }) },
    }) as Promise<Answer>;
  const code = (secret: string, offset = 0) =>
    totp.hotp(totp.base32Decode(secret) as Buffer, totp.totpStep(Date.now()) + offset);
  const me = (jwt: string) =>
    t.api(bearer(jwt), "/api/me") as Promise<
      Answer<{ mfa: { required: boolean; enrolled: boolean; restricted: boolean } }>
    >;
  const errorCode = (res: Answer) => res.body?.error?.details?.code;
  const row = async (id: number) =>
    (await t.strapi.db.query(USER).findOne({ where: { id } })) as Row;

  /** Setup + activation; returns the full JWT, the secret and the recovery codes. */
  async function enroll(jwt: string, password: string) {
    const setup = (await t.api(bearer(jwt), "/api/me/mfa/setup", { method: "POST" })) as Answer<{
      secret: string;
      otpauthUri: string;
      enrollment: string;
    }>;
    expect(setup.status, setup.text).toBe(200);
    expect(setup.headers.get("cache-control")).toContain("no-store");
    const { secret, enrollment } = setup.body.data!;
    const act = (await t.api(bearer(jwt), "/api/me/mfa/activate", {
      json: { enrollment, code: code(secret), password },
    })) as Answer<{ jwt: string; recoveryCodes: string[] }>;
    expect(act.status, act.text).toBe(200);
    return { jwt: act.body.data!.jwt, secret, codes: act.body.data!.recoveryCodes, enrollment };
  }

  let adminJwt = "";
  /** The fixture admin, enrolled once (admin_role requires a second factor here). */
  async function admin(): Promise<string> {
    if (adminJwt) return adminJwt;
    const user = t.fixtures.users.admin_role;
    const res = await signIn(user.username, user.password);
    adminJwt = (await enroll(res.body.jwt!, user.password)).jwt;
    return adminJwt;
  }

  it("a member signs in as before; /api/me says no second factor is needed", async () => {
    const user = t.fixtures.users.member;
    const res = await signIn(user.username, user.password);
    expect(res.status, res.text).toBe(200);
    expect((await me(res.body.jwt!)).body.data?.mfa).toEqual({
      required: false,
      enrolled: false,
      restricted: false,
    });
    expect((await t.api(bearer(res.body.jwt!), "/api/announcements")).status).toBe(200);
  });

  it("an editor's password sign-in is restricted to its profile and the enrollment", async () => {
    const user = t.fixtures.users.editor;
    const res = await signIn(user.username, user.password);
    expect(res.status, res.text).toBe(200);
    const jwt = res.body.jwt!;
    expect((await me(jwt)).body.data?.mfa).toEqual({
      required: true,
      enrolled: false,
      restricted: true,
    });
    for (const [method, path] of [
      ["GET", "/api/announcements"],
      ["GET", "/api/users/me"],
      ["PUT", "/api/me"],
      ["POST", "/api/me/mfa/disable"],
    ] as const) {
      const refused = (await t.api(bearer(jwt), path, {
        method,
        ...(method === "GET" ? {} : { json: {} }),
      })) as Answer;
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(refused.body.error?.name, `${method} ${path}`).toBe("MfaSetupRequired");
      expect(errorCode(refused)).toBe("mfa_setup_required");
    }
  });

  it("enrollment: the password, a code, ten recovery codes; then sign-in asks for a code", async () => {
    const user = t.fixtures.users.editor;
    const first = (await signIn(user.username, user.password)).body.jwt!;
    const setup = (await t.api(bearer(first), "/api/me/mfa/setup", { method: "POST" })) as Answer<{
      secret: string;
      enrollment: string;
      otpauthUri: string;
    }>;
    const { secret, enrollment, otpauthUri } = setup.body.data!;
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/sinnlos%3A/);
    const activate = (json: Record<string, unknown>) =>
      t.api(bearer(first), "/api/me/mfa/activate", { json }) as Promise<
        Answer<{ jwt: string; recoveryCodes: string[] }>
      >;
    expect(errorCode(await activate({ enrollment, code: code(secret) }))).toBe("password_invalid");
    expect(errorCode(await activate({ enrollment, code: "000000", password: user.password }))).toBe(
      "mfa_invalid",
    );
    expect(
      errorCode(
        await activate({ enrollment: "junk", code: code(secret), password: user.password }),
      ),
    ).toBe("enrollment_invalid");
    const done = await activate({ enrollment, code: code(secret), password: user.password });
    expect(done.status, done.text).toBe(200);
    expect(done.body.data!.recoveryCodes).toHaveLength(10);
    const full = done.body.data!.jwt;
    expect((await t.api(bearer(full), "/api/announcements")).status).toBe(200);
    // The restricted JWT of before is dead now (enrolled, no second factor in it).
    expect((await t.api(bearer(first), "/api/me")).status).toBe(401);
    // Not repeatable.
    const again = await t.api(bearer(full), "/api/me/mfa/setup", { method: "POST" });
    expect(again.status).toBe(409);

    const missing = await signIn(user.username, user.password);
    expect(missing.status).toBe(401);
    expect(errorCode(missing)).toBe("mfa_required");
    // The activation consumed this step: the same code again is a replay.
    expect(errorCode(await signIn(user.username, user.password, code(secret)))).toBe("mfa_invalid");
    later(1);
    const ok = await signIn(user.username, user.password, code(secret));
    expect(ok.status, ok.text).toBe(200);
    expect((await me(ok.body.jwt!)).body.data?.mfa).toEqual({
      required: true,
      enrolled: true,
      restricted: false,
    });
    expect((await row(user.id)).totpSecret).toMatch(/^v1:/);
  });

  it("recovery codes: each works once, two different ones at the same time both work", async () => {
    const user = t.fixtures.users.department_head;
    const jwt = (await signIn(user.username, user.password)).body.jwt!;
    const { codes } = await enroll(jwt, user.password);
    const [a, b] = await Promise.all([
      signIn(user.username, user.password, codes[0]),
      signIn(user.username, user.password, codes[1].toUpperCase().replace("-", "")),
    ]);
    expect([a.status, b.status], `${a.text} ${b.text}`).toEqual([200, 200]);
    const [c, d] = await Promise.all([
      signIn(user.username, user.password, codes[2]),
      signIn(user.username, user.password, codes[2]),
    ]);
    expect([c.status, d.status].sort()).toEqual([200, 401]);
    expect(errorCode(await signIn(user.username, user.password, codes[0]))).toBe("mfa_invalid");
    expect(((await row(user.id)).totpRecoveryCodes as string[]).length).toBe(7);
    // v0.30: 80-bit codes; a 10-character code issued before keeps working once.
    for (const issued of codes) expect(issued).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
    const stored = (await row(user.id)).totpRecoveryCodes as string[];
    await t.strapi.db.query(USER).update({
      where: { id: user.id },
      data: { totpRecoveryCodes: [...stored, mfa.hashRecoveryCode("abcde-23456")] },
    });
    const old = await signIn(user.username, user.password, "ABCDE23456");
    expect(old.status, old.text).toBe(200);
    expect(errorCode(await signIn(user.username, user.password, "abcde-23456"))).toBe(
      "mfa_invalid",
    );
  });

  it("disable: password and code, only when no role requires it; ends the other sessions", async () => {
    const user = t.fixtures.users.department_head;
    later(2);
    const signedIn = await signIn(user.username, user.password, code(await secretOf(user.id)));
    expect(signedIn.status, signedIn.text).toBe(200);
    const jwt = signedIn.body.jwt!;
    const disable = (json: Record<string, unknown>) =>
      t.api(bearer(jwt), "/api/me/mfa/disable", { json }) as Promise<Answer<{ jwt: string }>>;
    const recovery = ((await row(user.id)).totpRecoveryCodes as string[]).length;
    expect(recovery).toBeGreaterThan(0);
    expect(errorCode(await disable({ code: "123456" }))).toBe("password_invalid");
    expect(errorCode(await disable({ code: "123456", password: user.password }))).toBe(
      "mfa_invalid",
    );
    later(1);
    const off = await disable({ code: code(await secretOf(user.id)), password: user.password });
    expect(off.status, off.text).toBe(200);
    expect((await t.api(bearer(jwt), "/api/me")).status).toBe(401);
    expect((await me(off.body.data!.jwt)).body.data?.mfa.enrolled).toBe(false);
    expect((await signIn(user.username, user.password)).status).toBe(200);

    const editor = t.fixtures.users.editor;
    later(1);
    const editorJwt = (
      await signIn(editor.username, editor.password, code(await secretOf(editor.id)))
    ).body.jwt!;
    const refused = (await t.api(bearer(editorJwt), "/api/me/mfa/disable", {
      json: { code: "123456", password: editor.password },
    })) as Answer;
    expect(refused.status).toBe(403);
    expect(errorCode(refused)).toBe("mfa_required_by_role");
  });

  /** The plain secret of an enrolled user, unsealed as the cms does. */
  async function secretOf(id: number): Promise<string> {
    const sealed = (await row(id)).totpSecret as string;
    const encryption = (t.strapi as unknown as { service(uid: string): unknown }).service(
      "admin::encryption",
    ) as {
      decrypt(value: string): string | null;
    };
    return encryption.decrypt(sealed) ?? "";
  }

  it("an admin reset ends the user's sessions and the next sign-in enrolls again", async () => {
    const editor = t.fixtures.users.editor;
    later(2);
    const editorJwt = (
      await signIn(editor.username, editor.password, code(await secretOf(editor.id)))
    ).body.jwt!;
    const self = t.fixtures.users.admin_role.id;
    const ownReset = (await t.api(bearer(await admin()), `/api/user-management/${self}/reset-mfa`, {
      method: "POST",
    })) as Answer;
    expect(ownReset.status).toBe(400);
    const reset = (await t.api(
      bearer(await admin()),
      `/api/user-management/${editor.id}/reset-mfa`,
      { method: "POST" },
    )) as Answer<{ mfa: boolean }>;
    expect(reset.status, reset.text).toBe(200);
    expect(reset.body.data?.mfa).toBe(false);
    expect((await t.api(bearer(editorJwt), "/api/me")).status).toBe(401);
    const again = await signIn(editor.username, editor.password);
    expect(again.status).toBe(200);
    expect((await me(again.body.jwt!)).body.data?.mfa.restricted).toBe(true);
    for (const caller of ["member", null] as const) {
      expect(
        (await t.api(caller, `/api/user-management/${editor.id}/reset-mfa`, { method: "POST" }))
          .status,
      ).toBeGreaterThanOrEqual(401);
    }
  });

  it("a sign-in racing an admin reset never leaves a session with a second factor behind", async () => {
    const user = t.fixtures.users.team_lead;
    const first = (await signIn(user.username, user.password)).body.jwt!;
    await enroll(first, user.password);
    later(2);
    const [signedIn, reset] = await Promise.all([
      signIn(user.username, user.password, code(await secretOf(user.id))),
      t.api(bearer(await admin()), `/api/user-management/${user.id}/reset-mfa`, { method: "POST" }),
    ]);
    expect(reset.status, reset.text).toBe(200);
    if (signedIn.status === 200 && claimsOf(signedIn.body.jwt!).mfa === 1) {
      expect((await t.api(bearer(signedIn.body.jwt!), "/api/me")).status).toBe(401);
    }
    expect((await row(user.id)).totpEnabledAt ?? null).toBeNull();
  });

  it("refuses forged or foreign claims", async () => {
    const jwt = t.strapi.plugin("users-permissions").service("jwt") as unknown as {
      issue(payload: Record<string, unknown>): Promise<string>;
    };
    const editor = t.fixtures.users.editor;
    for (const claims of [{}, { am: "pw", mfa: "1" }, { am: "sso", mfa: 1 }]) {
      const token = await jwt.issue({ id: editor.id, ...claims });
      expect(
        (await t.api(bearer(token), "/api/announcements")).status,
        JSON.stringify(claims),
      ).toBe(401);
    }
    // A member has no second factor to prove: an old JWT without claims still works.
    const member = await jwt.issue({ id: t.fixtures.users.member.id });
    expect((await t.api(bearer(member), "/api/announcements")).status).toBe(200);
  });

  it("change-password keeps the session's assurance and applies the baseline", async () => {
    const user = t.fixtures.users.team_lead;
    const jwt = (await signIn(user.username, user.password)).body.jwt!;
    const change = (password: string) =>
      t.api(bearer(jwt), "/api/auth/change-password", {
        json: { currentPassword: user.password, password, passwordConfirmation: password },
      }) as Promise<Answer>;
    const common = await change("password1234");
    expect(common.status).toBe(400);
    expect(common.body.error?.message).toBe("password_common");
    expect((await change("short")).body.error?.message).toMatch(/password_tooShort|least/);
    const ok = await change("Team-Lead-Password-27");
    expect(ok.status, ok.text).toBe(200);
    expect((await t.api(bearer(ok.body.jwt!), "/api/announcements")).status).toBe(200);
    user.password = "Team-Lead-Password-27";
  });

  it("invitations: a mail with a link; the link sets a password once; then sign-in", async () => {
    mails.length = 0;
    const invite = (await t.api(bearer(await admin()), "/api/user-management/invite", {
      json: { data: { email: "New.Person@Integration.Test", displayName: "New Person" } },
    })) as Answer<{ id: number; mail: string }>;
    expect(invite.status, invite.text).toBe(201);
    expect(invite.body.data?.mail).toBe("sent");
    const id = invite.body.data!.id;
    expect(await row(id)).toMatchObject({
      email: "new.person@integration.test",
      provider: "local",
    });
    expect((await row(id)).password ?? null).toBeNull();
    expect(mails).toHaveLength(1);
    const token = /set-password#(\S+)/.exec(mails[0].text)?.[1] ?? "";
    expect(token).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    const list = (await t.api(
      bearer(await admin()),
      "/api/user-management?q=new.person",
    )) as Answer;
    expect(list.text).toContain('"invited":true');

    const set = (json: Record<string, unknown>, header = TOKEN) =>
      t.api(null, "/api/auth/password/set", {
        json,
        headers: header ? { "x-internal-token": header } : {},
      }) as Promise<Answer>;
    expect((await set({ token, password: "Strong-Password-27" }, "")).status).toBe(404);
    expect((await set({ token, password: "Strong-Password-27" }, "wrong")).status).toBe(404);
    expect(errorCode(await set({ token, password: "short" }))).toBe("password_tooShort");
    expect(errorCode(await set({ token, password: "password1234" }))).toBe("password_common");
    const [one, two] = await Promise.all([
      set({ token, password: "Strong-Password-27" }),
      set({ token, password: "Other-Password-27" }),
    ]);
    expect([one.status, two.status].sort()).toEqual([204, 400]);
    expect(errorCode(await set({ token, password: "Strong-Password-27" }))).toBe("token_invalid");
    const winner = one.status === 204 ? "Strong-Password-27" : "Other-Password-27";
    const signedIn = await signIn("new.person@integration.test", winner);
    expect(signedIn.status, signedIn.text).toBe(200);

    const taken = (await t.api(bearer(await admin()), "/api/user-management/invite", {
      json: { data: { email: "NEW.PERSON@integration.test" } },
    })) as Answer;
    expect(taken.status).toBe(400);
    expect(taken.text).toContain("taken");
  });

  it("a link is void once the account's e-mail address changes (invitation and reset)", async () => {
    const set = (token: string, password: string) =>
      t.api(null, "/api/auth/password/set", {
        json: { token, password },
        headers: { "x-internal-token": TOKEN },
      }) as Promise<Answer>;
    const lastLink = () =>
      /set-password#(\S+)/.exec(mails[mails.length - 1]?.text ?? "")?.[1] ?? "";
    const jwt = await admin();
    const sendLink = (id: number) =>
      t.api(bearer(jwt), `/api/user-management/${id}/send-link`, { method: "POST" });
    mails.length = 0;
    const invite = (await t.api(bearer(jwt), "/api/user-management/invite", {
      json: { data: { email: "mistyped@integration.test" } },
    })) as Answer<{ id: number }>;
    expect(invite.status, invite.text).toBe(201);
    const id = invite.body.data!.id;
    const invitation = lastLink();
    // The admin corrects the address through the Document Service (the Content Manager's path).
    await t.strapi.documents(USER).update({
      documentId: (await row(id)).documentId as string,
      data: { email: "corrected@integration.test" },
    });
    expect(errorCode(await set(invitation, "Strong-Password-27"))).toBe("token_invalid");
    expect((await row(id)).password ?? null).toBeNull();

    // Without an edit a link still works: a new invitation to the corrected address.
    expect((await sendLink(id)).status).toBe(200);
    expect((await set(lastLink(), "Strong-Password-27")).status).toBe(204);

    // A reset link, then the address changes by a direct query (no hooks at all).
    expect((await sendLink(id)).status).toBe(200);
    const reset = lastLink();
    expect(mails[mails.length - 1]?.subject).not.toBe(mails[mails.length - 2]?.subject);
    await t.strapi.db
      .query(USER)
      .update({ where: { id }, data: { email: "moved@integration.test" } });
    expect(errorCode(await set(reset, "Another-Password-27"))).toBe("token_invalid");
    expect((await signIn("moved@integration.test", "Strong-Password-27")).status).toBe(200);
  });

  it("no link for an account bound to an identity provider", async () => {
    const user = t.fixtures.users.department_head;
    await t.strapi.db.query(USER).update({
      where: { id: user.id },
      data: { entraTenantId: "tenant-1", microsoftOid: "oid-1" },
    });
    mails.length = 0;
    const forgot = await t.api(null, "/api/auth/password/forgot", {
      json: { email: user.email },
      headers: { "x-internal-token": TOKEN },
    });
    expect(forgot.status).toBe(202);
    const link = (await t.api(bearer(await admin()), `/api/user-management/${user.id}/send-link`, {
      method: "POST",
    })) as Answer;
    expect(link.status).toBe(400);
    expect(link.text).toContain("notLocal");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mails).toEqual([]);
    await t.strapi.db.query(USER).update({
      where: { id: user.id },
      data: { entraTenantId: null, microsoftOid: null },
    });
  });

  it("send-link and forgot: a reset link for a local account ends its sessions when used", async () => {
    const user = t.fixtures.users.guest;
    const jwt = (await signIn(user.username, user.password)).body.jwt!;
    mails.length = 0;
    const link = (await t.api(bearer(await admin()), `/api/user-management/${user.id}/send-link`, {
      method: "POST",
    })) as Answer<{ mail: string }>;
    expect(link.status, link.text).toBe(200);
    const token = /set-password#(\S+)/.exec(mails[0].text)?.[1] ?? "";
    const set = await t.api(null, "/api/auth/password/set", {
      json: { token, password: "Guest-Password-2027" },
      headers: { "x-internal-token": TOKEN },
    });
    expect(set.status, set.text).toBe(204);
    expect((await t.api(bearer(jwt), "/api/me")).status).toBe(401);
    user.password = "Guest-Password-2027";

    mails.length = 0;
    const forgot = (email: string) =>
      t.api(null, "/api/auth/password/forgot", {
        json: { email, locale: "de" },
        headers: { "x-internal-token": TOKEN },
      });
    const unknown = await forgot("nobody@integration.test");
    const known = await forgot(user.email.toUpperCase());
    expect([unknown.status, known.status]).toEqual([202, 202]);
    expect(unknown.text).toBe(known.text);
    for (let i = 0; i < 60 && mails.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(mails.map((mail) => mail.to)).toEqual([user.email]);
    expect(mails[0].subject).toBe("Passwort zurücksetzen");
    // An expired link is refused.
    const stored = (await row(user.id)).resetPasswordToken as string;
    await t.strapi.db.query(USER).update({
      where: { id: user.id },
      data: { resetPasswordToken: stored.replace(/^reset:\d+/, "reset:1") },
    });
    const expired = /set-password#(\S+)/.exec(mails[0].text)?.[1] ?? "";
    const refused = (await t.api(null, "/api/auth/password/set", {
      json: { token: expired, password: "Guest-Password-2028" },
      headers: { "x-internal-token": TOKEN },
    })) as Answer;
    expect(errorCode(refused)).toBe("token_invalid");
  });

  it("the baseline on Document Service writes; an old short password still signs in", async () => {
    const users = t.strapi.documents(USER);
    const member = t.fixtures.users.member;
    await expect(
      users.update({ documentId: member.documentId, data: { password: "short-one" } }),
    ).rejects.toThrow("password_tooShort");
    await expect(
      users.create({
        data: { username: "common-pw", email: "c@integration.test", password: "qwertyuiop12" },
      }),
    ).rejects.toThrow("password_common");
    // A password set before v0.27 (hashed directly) keeps working.
    const service = t.strapi.plugin("users-permissions").service("user") as unknown as {
      ensureHashedPasswords(values: Record<string, unknown>): Promise<{ password: string }>;
    };
    const { password } = await service.ensureHashedPasswords({ password: "old-pw" });
    await t.strapi.db.query(USER).update({ where: { id: member.id }, data: { password } });
    expect((await signIn(member.username, "old-pw")).status).toBe(200);
  });

  it("the plugin's own reset, registration and provider routes are closed", async () => {
    for (const [path, json] of [
      ["/api/auth/forgot-password", { email: "x@integration.test" }],
      [
        "/api/auth/reset-password",
        { code: "x", password: "Abcdefgh-123", passwordConfirmation: "Abcdefgh-123" },
      ],
      [
        "/api/auth/local/register",
        { username: "x", email: "x@integration.test", password: "Abcdefgh-123" },
      ],
      ["/api/auth/send-email-confirmation", { email: "x@integration.test" }],
    ] as const) {
      const res = await t.api(null, path, { json });
      expect([403, 404], path).toContain(res.status);
    }
    expect([403, 404]).toContain((await t.api(null, "/api/connect/github")).status);
    expect([403, 404]).toContain(
      (await t.api(null, "/api/auth/github/callback?access_token=x")).status,
    );
  });

  it.skipIf(engine !== "postgres")(
    "an admin reset waits for a concurrent sign-out of the admin and is then refused",
    async () => {
      const caller = t.fixtures.users.admin_role;
      const target = t.fixtures.users.department_head;
      const jwt = await admin();
      await enroll((await signIn(target.username, target.password)).body.jwt!, target.password);
      // The admin's password changes in another transaction, not committed yet: it holds the row.
      const held = await holdTransaction(t);
      await held.raw(
        `UPDATE ${qualified(t, "up_users")} SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?`,
        [caller.id],
      );
      const reset = settle(
        t.api(bearer(jwt), `/api/user-management/${target.id}/reset-mfa`, {
          method: "POST",
        }) as Promise<Answer>,
      );
      try {
        // Without the caller's row lock the reset would pass on the old version and never wait.
        await waitForLockWait(t);
      } finally {
        await held.commit();
      }
      const res = await reset;
      if ("error" in res) throw res.error;
      expect(res.value.status, res.value.text).toBe(401);
      expect(errorCode(res.value)).toBe("session_outdated");
      expect((await row(target.id)).totpEnabledAt).not.toBeNull();
      later(2);
      adminJwt = (await signIn(caller.username, caller.password, code(await secretOf(caller.id))))
        .body.jwt!;
    },
  );

  it("has the columns infra/mfa-reset.sh writes", async () => {
    const knex = t.strapi.db.connection as unknown as { raw(sql: string): Promise<unknown> };
    const result = await knex.raw(
      engine === "postgres"
        ? "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'up_users'"
        : "SELECT name FROM pragma_table_info('up_users')",
    );
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
      name: string;
    }[];
    const names = rows.map((r) => r.name);
    for (const column of [
      "email",
      "username",
      "token_version",
      "totp_secret",
      "totp_enabled_at",
      "totp_last_step",
      "totp_recovery_codes",
    ])
      expect(names, column).toContain(column);
  });

  it("e-mail addresses are unique in the database, case-insensitively", async () => {
    const sql =
      engine === "postgres"
        ? `SELECT indexname AS name FROM pg_indexes WHERE indexname = 'up_users_email_lower_uq' AND schemaname = '${testSchema(t)}'`
        : "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'up_users_email_lower_uq'";
    const knex = t.strapi.db.connection as unknown as { raw(sql: string): Promise<unknown> };
    const result = await knex.raw(sql);
    const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
    expect(rows).toHaveLength(1);
  });
});
