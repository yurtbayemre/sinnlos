import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  bumpTokenVersion,
  currentTokenVersion,
  type RawRunner,
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
 *      the bump leaves the old password with the older JWTs revoked;
 *   7. a password an admin sets in the Content Manager revokes too (the
 *      Document Service guard), and no write sets the version: not the
 *      Content Manager, PUT /api/users/:id, PUT /api/me or the user
 *      service's add() (register, POST /api/users).
 */

/** A JWT signed like the plugin's legacy issue() did before FX40: no `tv`. */
function legacyJwt(secret: string, id: number): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ id, iat: now, exp: now + 3600 })}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

const ADMIN_EMAIL = "it-admin@integration.test";
const ADMIN_PASSWORD = "It-Admin-Pass-123";

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
    // The seeded super admin signs in to the Content Manager below.
    t = await createTestStrapi({
      engine,
      env: { STRAPI_ADMIN_EMAIL: ADMIN_EMAIL, STRAPI_ADMIN_PASSWORD: ADMIN_PASSWORD },
    });
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
      // The bump runs on the change's transaction (or, outside one, on the
      // connection): both fail its UPDATE.
      const failing = (runner: RawRunner): RawRunner => ({
        raw: (sql, bindings) =>
          /^UPDATE\b/.test(sql) && sql.includes("token_version")
            ? Promise.reject(new Error("connection lost"))
            : runner.raw(sql, bindings),
      });
      const connection = strapi.db.connection as RawRunner;
      const raw = connection.raw.bind(connection);
      vi.spyOn(connection, "raw").mockImplementation((sql, bindings) =>
        failing({ raw }).raw(sql, bindings),
      );
      const transaction = strapi.db.transaction.bind(strapi.db);
      vi.spyOn(strapi.db, "transaction").mockImplementation(((
        callback?: (scope: { trx: RawRunner }) => Promise<unknown>,
      ) =>
        callback
          ? transaction((scope) => callback({ ...scope, trx: failing(scope.trx) }))
          : (
              transaction as unknown as () => unknown
            )()) as TokenVersionStrapi["db"]["transaction"]);
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

    it("a failed save rolls the bump back: an error, the old password, the sessions as they were", async () => {
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
      // One transaction: the bump went with the failed save.
      expect(await currentTokenVersion(strapi, id)).toBe(start);
      expect((await me(signedIn)).status).toBe(200);
      await expect(t.login(username, "Never-Saved-Pass-2")).rejects.toThrow("failed: 400");
      const again = await t.login(username, password);
      expect(claims(again).tv).toBe(start);
      expect((await me(again)).status).toBe(200);
    });
  });

  describe("one transaction per password change: a held change, a sign-in and a second change meanwhile", () => {
    const USER_TYPE = "plugin::users-permissions.user";
    let holdFor: string | null = null;
    let reach: () => void = () => undefined;
    let release: () => void = () => undefined;
    let holdAdded = false;
    let seq = 0;

    /**
     * Holds the Document Service update that writes `password` (after the
     * guard, so inside the change's transaction, after its bump; before
     * the code of this fix, after the committed bump) until release().
     */
    const holdSave = (password: string) => {
      if (!holdAdded) {
        holdAdded = true;
        const documents = t.strapi.documents as unknown as {
          use(
            middleware: (
              context: { uid: string; action: string; params?: { data?: { password?: unknown } } },
              next: () => Promise<unknown>,
            ) => Promise<unknown>,
          ): void;
        };
        documents.use(async (context, next) => {
          if (
            holdFor !== null &&
            context.uid === USER_TYPE &&
            context.action === "update" &&
            context.params?.data?.password === holdFor
          ) {
            holdFor = null;
            reach();
            await new Promise<void>((resolve) => (release = resolve));
          }
          return next();
        });
      }
      holdFor = password;
      return new Promise<void>((resolve) => (reach = resolve));
    };

    /**
     * Resolves "done" once `work` settled, or "waits" once a statement waits
     * for the change's transaction: SQLite's only connection is taken
     * (knex pool), or a Postgres lock is not granted. Condition-driven.
     */
    const doneOrWaiting = async (work: Promise<unknown>) => {
      let settled = false;
      work.then(
        () => (settled = true),
        () => (settled = true),
      );
      const pool = (
        t.strapi.db as unknown as {
          connection: { client: { pool: { numPendingAcquires(): number } } };
        }
      ).connection.client.pool;
      const waiting = async () =>
        engine === "sqlite"
          ? pool.numPendingAcquires() > 0
          : ((
              await t.database.sql<{ n: number }>(
                "SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted",
              )
            )[0]?.n ?? 0) > 0;
      for (let turn = 0; turn < 100_000; turn += 1) {
        if (settled) return "done";
        if (await waiting()) return "waits";
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error("neither done nor waiting");
    };

    /** A new local account through the user service's add(). */
    const newAccount = async () => {
      seq += 1;
      const role = await t.strapi.db
        .query("plugin::users-permissions.role")
        .findOne({ where: { type: "authenticated" } });
      const users = t.strapi.plugin("users-permissions").service("user") as {
        add(values: object): Promise<{ id: number }>;
      };
      const account = {
        username: `it-tx-${engine}-${seq}`,
        email: `it-tx-${engine}-${seq}@integration.test`,
        password: `Tx-Pass-${seq}-123`,
      };
      const created = await users.add({
        ...account,
        provider: "local",
        confirmed: true,
        role: role?.id,
      });
      return { ...account, id: created.id };
    };

    /**
     * The plugin's own changePassword (the wrapped controller, the real user
     * service and Document Service) for a caller that has authenticated
     * already, as a second tab whose request passed the JWT check before
     * the other tab's change began; the JWT of its answer.
     */
    const changeAs = async (id: number, currentPassword: string, password: string) => {
      const auth = (
        t.strapi as unknown as {
          plugin(name: string): {
            controller(name: string): { changePassword(ctx: object): Promise<unknown> };
          };
        }
      )
        .plugin("users-permissions")
        .controller("auth");
      const ctx: { body?: { jwt?: string }; [key: string]: unknown } = {
        state: {
          user: { id },
          auth: { strategy: { name: "users-permissions" }, credentials: { id } },
        },
        request: {
          body: { currentPassword, password, passwordConfirmation: password },
          header: {},
          headers: {},
        },
        params: {},
        query: {},
      };
      ctx.send = (body: unknown) => {
        ctx.body = body as { jwt?: string };
      };
      await auth.changePassword(ctx);
      return ctx.body?.jwt ?? "";
    };

    const accepts = async (jwt: string) => (await me(jwt)).status === 200;

    it("a sign-in with the old password while a change is held keeps no session (3 runs)", async () => {
      for (let run = 0; run < 3; run += 1) {
        const account = await newAccount();
        const signedIn = await t.login(account.username, account.password);
        const held = holdSave(`Held-Pass-${run}-1`);
        const change = changePassword(signedIn, account.password, `Held-Pass-${run}-1`);
        await held;
        // Before this fix the bump had committed here: the sign-in read
        // the new version next to the old password.
        const signIn = t.login(account.username, account.password);
        signIn.catch(() => undefined);
        await doneOrWaiting(signIn);
        release();
        expect((await change).status).toBe(200);
        const jwt = await signIn.then(
          (value) => value,
          () => null,
        );
        // Postgres: the sign-in read the old row (old password, old
        // version), so its JWT is revoked by the commit; SQLite: it waited
        // for the commit and the old password no longer signs in.
        if (jwt !== null) expect(await accepts(jwt)).toBe(false);
        else expect(engine).toBe("sqlite");
        expect(await accepts(signedIn)).toBe(false);
      }
    });

    it("overlapping changes: the stored password belongs to the only accepted JWT (3 runs)", async () => {
      for (let run = 0; run < 3; run += 1) {
        const account = await newAccount();
        const first = `First-Pass-${run}-1`;
        const second = `Second-Pass-${run}-2`;
        const held = holdSave(first);
        const a = changeAs(account.id, account.password, first);
        a.catch(() => undefined);
        await held;
        const b = changeAs(account.id, account.password, second);
        b.catch(() => undefined);
        await doneOrWaiting(b);
        release();
        const jwts: Record<string, string | null> = {
          [first]: await a.catch(() => null),
          [second]: await b.catch(() => null),
        };
        // Which password the account has now: exactly one signs in.
        const stored: string[] = [];
        for (const password of [first, second]) {
          if (
            await t.login(account.username, password).then(
              () => true,
              () => false,
            )
          ) {
            stored.push(password);
          }
        }
        expect(stored).toHaveLength(1);
        const accepted: string[] = [];
        for (const [password, jwt] of Object.entries(jwts)) {
          if (jwt && (await accepts(jwt))) accepted.push(password);
        }
        expect(accepted).toEqual(stored);
        // Postgres: B checked the old password before A committed and ran
        // after it; SQLite: B waited and then found the old password gone.
        expect(stored[0]).toBe(engine === "postgres" ? second : first);
      }
    });
  });

  describe("admin-panel passwords revoke too; no write can set the version", () => {
    const adminPath = (documentId: string) =>
      `/content-manager/collection-types/plugin::users-permissions.user/${documentId}`;
    let adminJwt = "";
    let apiToken = "";
    let seq = 0;

    /** The seeded super admin's JWT (POST /admin/login), once. */
    const admin = async () => {
      if (!adminJwt) {
        const res = await t.api<{ data?: { token?: string } }>(null, "/admin/login", {
          json: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        });
        expect(res.status).toBe(200);
        adminJwt = res.body.data?.token ?? "";
      }
      return adminJwt;
    };

    /** A full-access API token: the one kind of caller that reaches PUT /api/users/:id. */
    const fullAccess = async () => {
      if (!apiToken) {
        const tokens = t.strapi as unknown as {
          service(uid: string): { create(input: object): Promise<{ accessKey: string }> };
        };
        apiToken = (
          await tokens.service("admin::api-token").create({
            name: `it-full-access-${engine}`,
            type: "full-access",
            lifespan: null,
            description: "",
          })
        ).accessKey;
      }
      return apiToken;
    };

    /**
     * A new local user through the users-permissions user service's add(),
     * the path of POST /api/auth/local/register and POST /api/users, with a
     * tokenVersion in its data that the write must not keep.
     */
    const newUser = async () => {
      seq += 1;
      const role = await t.strapi.db
        .query("plugin::users-permissions.role")
        .findOne({ where: { type: "authenticated" } });
      const users = t.strapi.plugin("users-permissions").service("user") as {
        add(values: object): Promise<{ id: number; documentId: string }>;
      };
      const account = {
        username: `it-guard-${engine}-${seq}`,
        email: `it-guard-${engine}-${seq}@integration.test`,
        password: `Guard-Pass-${seq}-123`,
      };
      const created = await users.add({
        ...account,
        provider: "local",
        confirmed: true,
        role: role?.id,
        tokenVersion: 7,
      });
      return { ...account, id: created.id, documentId: created.documentId };
    };

    const version = (id: number) =>
      currentTokenVersion(t.strapi as unknown as TokenVersionStrapi, id);

    it("a new user starts at version 0 whatever its data says (register, POST /api/users)", async () => {
      const account = await newUser();
      expect(await version(account.id)).toBe(0);
      expect(claims(await t.login(account.username, account.password)).tv).toBe(0);
    });

    it("a password set in the Content Manager revokes the user's older JWTs", async () => {
      const account = await newUser();
      const signedIn = await t.login(account.username, account.password);
      const res = await t.api({ jwt: await admin() }, adminPath(account.documentId), {
        method: "PUT",
        json: { password: "Admin-Set-Pass-1" },
      });
      expect(res.status).toBe(200);
      expect(await version(account.id)).toBe(1);
      expect((await me(signedIn)).status).toBe(401);
      await expect(t.login(account.username, account.password)).rejects.toThrow("failed: 400");
      const again = await t.login(account.username, "Admin-Set-Pass-1");
      expect(claims(again).tv).toBe(1);
      expect((await me(again)).status).toBe(200);
    });

    it("a Content Manager update without a password revokes nothing", async () => {
      const account = await newUser();
      const signedIn = await t.login(account.username, account.password);
      const res = await t.api({ jwt: await admin() }, adminPath(account.documentId), {
        method: "PUT",
        json: { displayName: "Renamed by an admin" },
      });
      expect(res.status).toBe(200);
      expect(await version(account.id)).toBe(0);
      expect((await me(signedIn)).status).toBe(200);
    });

    it("the Content Manager cannot set the version back", async () => {
      const account = await newUser();
      await t.api({ jwt: await admin() }, adminPath(account.documentId), {
        method: "PUT",
        json: { password: "Admin-Set-Pass-2" },
      });
      const revoked = legacyJwt(secret, account.id); // version 0, refused at version 1
      expect((await me(revoked)).status).toBe(401);
      const res = await t.api({ jwt: await admin() }, adminPath(account.documentId), {
        method: "PUT",
        json: { tokenVersion: 0 },
      });
      expect(res.status).toBe(200);
      expect(await version(account.id)).toBe(1);
      expect((await me(revoked)).status).toBe(401);
    });

    it("PUT /api/users/:id cannot set it back, and with a password raises it exactly once", async () => {
      const account = await newUser();
      const signedIn = await t.login(account.username, account.password);
      const token = await fullAccess();
      const lowered = await t.api({ jwt: token }, `/api/users/${account.id}`, {
        method: "PUT",
        json: { jobTitle: "Tester", tokenVersion: 5 },
      });
      expect(lowered.status).toBe(200);
      expect(await version(account.id)).toBe(0);
      const changed = await t.api({ jwt: token }, `/api/users/${account.id}`, {
        method: "PUT",
        json: { password: "Api-Set-Pass-3", tokenVersion: 0 },
      });
      expect(changed.status).toBe(200);
      // edit() bumped, the Document Service guard did not bump again.
      expect(await version(account.id)).toBe(1);
      expect((await me(signedIn)).status).toBe(401);
    });

    it("PUT /api/me cannot set it (the profile allowlist)", async () => {
      const account = await newUser();
      const signedIn = await t.login(account.username, account.password);
      const res = await t.api({ jwt: signedIn }, "/api/me", {
        method: "PUT",
        json: { jobTitle: "Self", tokenVersion: 3 },
      });
      expect(res.status).toBe(200);
      expect(await version(account.id)).toBe(0);
      expect((await me(signedIn)).status).toBe(200);
    });

    it("change-password raises it exactly once (edit() and the Document Service guard)", async () => {
      const account = await newUser();
      const signedIn = await t.login(account.username, account.password);
      const res = await changePassword(signedIn, account.password, "Changed-Pass-4");
      expect(res.status).toBe(200);
      expect(await version(account.id)).toBe(1);
      expect(claims(res.body.jwt ?? "").tv).toBe(1);
      expect((await me(res.body.jwt ?? "")).status).toBe(200);
    });
  });

  it("keeps the version private: not filterable through the API", async () => {
    const admin = await t.loginAs("admin_role");
    const res = await t.api({ jwt: admin }, "/api/users?filters[tokenVersion][$eq]=1");
    expect(res.status).toBe(400);
  });
});
