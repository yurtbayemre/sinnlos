import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ENV,
  adminRequest,
  adminToken,
  createUser,
  signIn,
  type CreatedUser,
} from "./admin-api.test.helper";
import {
  createTestStrapi,
  testEngines,
  type ApiResponse,
  type Caller,
  type Row,
  type TestStrapi,
} from "./harness.test.helper";
import {
  holdTransaction,
  lockWaits,
  qualified,
  settle,
  waitForLockWait,
} from "./pg-lock.test.helper";

/**
 * Secret shares under concurrency and failure (v0.35.0, plan §3.4 and §6):
 *
 *   - the commit confirmation: a COMMIT that fails (a deferred constraint
 *     violated inside the reveal's transaction) answers `busy` without the
 *     text and leaves the share pending; a COMMIT that succeeds but whose
 *     confirmation is lost answers `busy` without the text and leaves the
 *     share retrieved; on SQLite the next transaction runs on a connection
 *     outside any transaction (the failed one is disposed of, never reused);
 *   - the fresh caller check under the locks (Postgres: a reveal or revoke
 *     queued behind the directory lock): a block, a sign-out or an
 *     anonymisation committed while it waited makes it lose; a member
 *     promoted to editor meets the editor's second-factor rule; password,
 *     second-factor and identity-provider sessions still pass;
 *   - a sender revokes although the recipient is blocked;
 *   - the Content Manager's bulk deletion of both users racing a reveal
 *     rolls back safely: the text leaves only with a 200;
 *   - an MFA-pending session gets none of the routes.
 * MFA_REQUIRED_ROLES=editor for the whole file.
 */

const UID = "api::secret-share.secret-share";
const NOTIFICATION = "api::notification.notification";
const USER = "plugin::users-permissions.user";
const ROLE = "plugin::users-permissions.role";

type Body = {
  data?: { id?: string; text?: string };
  error?: { details?: { code?: string } };
};

interface Subscriber {
  models: string[];
  afterDeleteMany?: (event: unknown) => Promise<void>;
}
interface LifecycleDb {
  lifecycles: { subscribe(subscriber: Subscriber): () => void };
  transaction<T>(cb: (scope: { trx: KnexTrx }) => Promise<T>): Promise<T>;
  connection: {
    raw(sql: string): Promise<unknown>;
    client: { acquireConnection(): Promise<SqliteConnection>; releaseConnection(c: unknown): void };
  };
}
interface KnexTrx {
  raw(sql: string, bindings?: unknown[]): Promise<unknown>;
  executionPromise?: Promise<unknown>;
  client: { acquireConnection(): Promise<SqliteConnection> };
}
interface SqliteConnection {
  inTransaction?: boolean;
  open?: boolean;
}

describe.each(testEngines())("secret shares under locks and failures on %s", (engine) => {
  let t: TestStrapi;
  let reset: () => void;

  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: { ...ADMIN_ENV, MFA_REQUIRED_ROLES: "editor" } });
    reset = t.requireBuilt<{ __resetCreateLimiterForTest(): void }>(
      "src/utils/secret-shares",
    ).__resetCreateLimiterForTest;
    const db = t.strapi.db as unknown as LifecycleDb;
    // A deferred foreign key: violated inside a transaction, it fails only at COMMIT.
    await db.connection.raw(
      engine === "sqlite"
        ? 'CREATE TABLE "it_deferred_parent" ("id" INTEGER PRIMARY KEY)'
        : `CREATE TABLE ${qualified(t, "it_deferred_parent")} ("id" INTEGER PRIMARY KEY)`,
    );
    await db.connection.raw(
      engine === "sqlite"
        ? 'CREATE TABLE "it_deferred_child" ("parent" INTEGER REFERENCES "it_deferred_parent" ("id") DEFERRABLE INITIALLY DEFERRED)'
        : `CREATE TABLE ${qualified(t, "it_deferred_child")} ("parent" INTEGER REFERENCES ${qualified(t, "it_deferred_parent")} ("id") DEFERRABLE INITIALLY DEFERRED)`,
    );
  });
  afterAll(async () => {
    await t?.stop();
  });
  beforeEach(() => reset());

  const db = () => t.strapi.db as unknown as LifecycleDb;
  const api = (caller: Caller, path: string, init?: Parameters<TestStrapi["api"]>[2]) =>
    t.api<Body>(caller, path, init) as Promise<ApiResponse<Body>>;
  const as = async (user: CreatedUser): Promise<Caller> => ({ jwt: await signIn(t, user) });
  const reveal = (caller: Caller, id: string) =>
    api(caller, `/api/secret-shares/${id}/reveal`, { method: "POST" });
  const revoke = (caller: Caller, id: string) =>
    api(caller, `/api/secret-shares/${id}/revoke`, { method: "POST" });
  const state = async (documentId: string) =>
    ((await t.strapi.db.query(UID).findOne({ where: { documentId } })) as Row | null)?.state;
  const code = (res: ApiResponse<Body>) => res.body?.error?.details?.code;
  const jwtService = () =>
    t.strapi.plugin("users-permissions").service("jwt") as unknown as {
      issue(payload: Record<string, unknown>): Promise<string>;
    };

  async function shared(senderRole: "member" | "editor" = "member") {
    const sender = await createUser(t, senderRole);
    const recipient = await createUser(t, "member");
    const from: Caller =
      senderRole === "editor"
        ? { jwt: await jwtService().issue({ id: sender.id, am: "pw", mfa: 1 }) }
        : await as(sender);
    const to = await as(recipient);
    const text = `locked-${randomBytes(6).toString("hex")}`;
    const res = await api(from, "/api/secret-shares", {
      json: { recipient: recipient.id, text, lifetime: "1h" },
    });
    expect(res.status, res.text).toBe(201);
    return { sender, recipient, from, to, text, id: res.body.data!.id as string };
  }

  /** Runs `hook` inside the next transaction that deletes a notification (the end of a share). */
  function duringNextEnd(hook: (trx: KnexTrx) => Promise<void>): () => void {
    let used = false;
    return db().lifecycles.subscribe({
      models: [NOTIFICATION],
      afterDeleteMany: async () => {
        if (used) return;
        used = true;
        await db().transaction(({ trx }) => hook(trx));
      },
    });
  }

  it("an MFA-pending session gets none of the routes", async () => {
    const editor = t.fixtures.users.editor;
    const jwt = await signIn(t, editor);
    for (const [method, path] of [
      ["GET", "/api/secret-shares"],
      ["POST", "/api/secret-shares"],
      ["GET", "/api/secret-shares/recipients"],
    ]) {
      const res = await api({ jwt }, path, { method, json: method === "POST" ? {} : undefined });
      expect(res.status, path).toBe(403);
      expect(code(res), path).toBe("mfa_setup_required");
    }
  });

  it("a failed COMMIT returns no text and leaves the share pending; the next transaction works", async () => {
    const { id, to, text } = await shared();
    let connection: SqliteConnection | null = null;
    const off = duringNextEnd(async (trx) => {
      connection = await trx.client.acquireConnection();
      await trx.raw(
        engine === "sqlite"
          ? 'INSERT INTO "it_deferred_child" ("parent") VALUES (424242)'
          : `INSERT INTO ${qualified(t, "it_deferred_child")} ("parent") VALUES (424242)`,
      );
    });
    try {
      const res = await reveal(to, id);
      expect(res.status).toBe(503);
      expect(code(res)).toBe("busy");
      expect(res.text).not.toContain(text);
    } finally {
      off();
    }
    expect(await state(id)).toBe("pending");
    expect(
      await t.strapi.db
        .query(NOTIFICATION)
        .count({ where: { type: "secretShared", link: `/secrets/${id}` } }),
    ).toBe(1);
    if (engine === "sqlite") {
      // The connection the failed COMMIT left inside its transaction is never handed out again.
      const next = await db().connection.client.acquireConnection();
      try {
        expect(next.inTransaction).toBe(false);
        expect(next).not.toBe(connection);
      } finally {
        db().connection.client.releaseConnection(next);
      }
      expect((connection as SqliteConnection | null)?.open).toBe(false);
    }
    const opened = await reveal(to, id);
    expect(opened.status, opened.text).toBe(200);
    expect(opened.body.data?.text).toBe(text);
  });

  it("a COMMIT whose acknowledgement is lost leaves the share retrieved and answers busy without text", async () => {
    const { id, to, text } = await shared();
    const off = duringNextEnd(async (trx) => {
      const lost = Promise.reject(new Error("connection lost after COMMIT"));
      lost.catch(() => undefined);
      trx.executionPromise = lost;
    });
    try {
      const res = await reveal(to, id);
      expect(res.status).toBe(503);
      expect(code(res)).toBe("busy");
      expect(res.text).not.toContain(text);
    } finally {
      off();
    }
    expect(await state(id)).toBe("retrieved");
    expect(code(await reveal(to, id))).toBe("gone");
  });

  it("a sender revokes although the recipient is blocked", async () => {
    const { id, from, recipient } = await shared();
    await t.strapi.db.query(USER).update({ where: { id: recipient.id }, data: { blocked: true } });
    const res = await revoke(from, id);
    expect(res.status, res.text).toBe(200);
    expect(await state(id)).toBe("revoked");
  });

  it("password, second-factor and identity-provider sessions pass the fresh check", async () => {
    const editor = await shared("editor");
    expect((await reveal(editor.to, editor.id)).body.data?.text).toBe(editor.text);
    const idp = await shared();
    const idpJwt = await jwtService().issue({ id: idp.recipient.id, am: "idp" });
    expect((await reveal({ jwt: idpJwt }, idp.id)).body.data?.text).toBe(idp.text);
  });

  describe.runIf(engine === "postgres")("queued behind the directory lock", () => {
    /** Holds the directory lock, runs `request`, waits until it queues, then applies `meanwhile`. */
    async function queued<T>(request: () => Promise<T>, meanwhile: () => Promise<unknown>) {
      const probe = await holdTransaction(t);
      let pending: ReturnType<typeof settle<T>>;
      try {
        await probe.raw(
          `SELECT 1 FROM ${qualified(t, "content_versions")} WHERE target_uid = ? AND target_document_id = ? FOR UPDATE`,
          ["sinnlos::user-directory", "global"],
        );
        pending = settle(request());
        await waitForLockWait(t);
        await meanwhile();
      } finally {
        await probe.commit();
      }
      const done = await pending!;
      if (!done.ok) throw (done as { error: unknown }).error;
      return (done as { value: T }).value;
    }

    it("a reveal queued behind a block loses", async () => {
      const { id, to, recipient, text } = await shared();
      const res = await queued(
        () => reveal(to, id),
        () =>
          t.strapi.db.query(USER).update({ where: { id: recipient.id }, data: { blocked: true } }),
      );
      expect(res.status).toBe(401);
      expect(res.text).not.toContain(text);
      expect(await state(id)).toBe("pending");
    });

    it("a reveal and a revoke queued behind a sign-out lose", async () => {
      const a = await shared();
      const res = await queued(
        () => reveal(a.to, a.id),
        () => api(a.to, "/api/me/sign-out", { method: "POST" }),
      );
      expect(res.status).toBe(401);
      expect(await state(a.id)).toBe("pending");
      const b = await shared();
      const revoked = await queued(
        () => revoke(b.from, b.id),
        () => api(b.from, "/api/me/sign-out", { method: "POST" }),
      );
      expect(revoked.status).toBe(401);
      expect(await state(b.id)).toBe("pending");
    });

    it("a revoke queued behind a block of the sender loses", async () => {
      const { id, from, sender } = await shared();
      const res = await queued(
        () => revoke(from, id),
        () => t.strapi.db.query(USER).update({ where: { id: sender.id }, data: { blocked: true } }),
      );
      expect(res.status).toBe(401);
      expect(await state(id)).toBe("pending");
    });

    it("a member promoted to editor while the reveal waits meets the editor's second-factor rule", async () => {
      const { id, to, recipient, text } = await shared();
      const editorRole = (await t.strapi.db
        .query(ROLE)
        .findOne({ where: { type: "editor" } })) as Row;
      const res = await queued(
        () => reveal(to, id),
        () =>
          t.strapi.db
            .query(USER)
            .update({ where: { id: recipient.id }, data: { role: editorRole.id } }),
      );
      expect(res.status).toBe(403);
      expect(code(res)).toBe("mfa_setup_required");
      expect(res.text).not.toContain(text);
      expect(await state(id)).toBe("pending");
    });

    it("a reveal queued behind an anonymisation of the sender loses", async () => {
      const { id, to, sender, text } = await shared();
      await t.strapi.db.query(USER).update({ where: { id: sender.id }, data: { blocked: true } });
      const probe = await holdTransaction(t);
      let anonymise: ReturnType<typeof settle<ApiResponse<Body>>>;
      let opened: ReturnType<typeof settle<ApiResponse<Body>>>;
      try {
        await probe.raw(
          `SELECT 1 FROM ${qualified(t, "content_versions")} WHERE target_uid = ? AND target_document_id = ? FOR UPDATE`,
          ["sinnlos::user-directory", "global"],
        );
        anonymise = settle(
          api("admin_role", `/api/user-management/${sender.id}/anonymise`, {
            json: { confirm: sender.username },
          }),
        );
        await waitForLockWait(t);
        opened = settle(reveal(to, id));
        await expect.poll(() => lockWaits(t), { timeout: 10_000 }).toBeGreaterThan(1);
      } finally {
        await probe.commit();
      }
      const ran = await anonymise!;
      const got = await opened!;
      expect(ran.ok && ran.value.status).toBe(200);
      expect(got.ok).toBe(true);
      if (got.ok) {
        expect(got.value.status).not.toBe(200);
        expect(got.value.text).not.toContain(text);
      }
      expect(await state(id)).toBeUndefined();
    });

    it("a Content Manager bulk deletion of both users racing a reveal: the text leaves only with a 200", async () => {
      const { id, to, sender, recipient, text } = await shared();
      const token = await adminToken(t);
      const [deleted, opened] = await Promise.all([
        adminRequest(t, token, `/content-manager/collection-types/${USER}/actions/bulkDelete`, {
          json: { documentIds: [sender.documentId, recipient.documentId] },
        }),
        reveal(to, id),
      ]);
      expect(deleted.status, deleted.text).toBe(200);
      if (opened.status === 200) {
        expect(opened.body.data?.text).toBe(text);
      } else {
        expect([401, 404, 410, 503]).toContain(opened.status);
        expect(opened.text).not.toContain(text);
      }
      const janitor = t.requireBuilt<{ runSecretShareJanitor(s: unknown): Promise<unknown> }>(
        "src/cron/secret-share-janitor",
      );
      await janitor.runSecretShareJanitor(t.strapi);
      expect(await state(id)).toBeUndefined();
    });
  });
});
