import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SECRET_CREATES_PER_DAY,
  SECRET_PENDING_PER_SENDER,
  SECRET_SHARE_RETENTION_MS,
} from "@sinnlos/domain";

import { createUser, signIn, type CreatedUser } from "./admin-api.test.helper";
import {
  TEST_ROLES,
  createTestStrapi,
  testEngines,
  type ApiResponse,
  type Caller,
  type Row,
  type TestRole,
  type TestStrapi,
} from "./harness.test.helper";

/**
 * Secret sharing (v0.35.0, docs/plan-v035-secret-sharing.md §6) against the
 * real cms over HTTP, on SQLite and Postgres 16: who may call what, the read
 * once rule, the refusals and their codes, the caps, the key change, the
 * transient block, the janitor (also with the module off), anonymisation,
 * the export, a restart, and the cms half of the sentinel test: the text is
 * nowhere in the database, the logs or a notification afterwards.
 * The lock races are in secret-shares-locks.integration.test.ts, the admin
 * panel in secret-shares-admin.integration.test.ts.
 */

const UID = "api::secret-share.secret-share";
const NOTIFICATION = "api::notification.notification";
const USER = "plugin::users-permissions.user";

type Body = {
  data?: Record<string, unknown> & {
    id?: string;
    text?: string;
    received?: Record<string, unknown>[];
    sent?: Record<string, unknown>[];
    hasMore?: boolean;
  };
  error?: { status?: number; name?: string; details?: { code?: string } };
};

interface Janitor {
  runSecretShareJanitor(strapi: unknown): Promise<Record<string, number>>;
}
interface SharesModule {
  __resetCreateLimiterForTest(): void;
}
interface CryptoModule {
  configureShareKey(key: unknown, moduleOn: boolean, log: { error(m: string): void }): void;
}

describe.each(testEngines())("secret shares on %s", (engine) => {
  let t: TestStrapi;
  let janitor: Janitor;
  let shares: SharesModule;
  const logged: string[] = [];

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    janitor = t.requireBuilt<Janitor>("src/cron/secret-share-janitor");
    shares = t.requireBuilt<SharesModule>("src/utils/secret-shares");
    // Every log line of the run, for the sentinel checks.
    const log = t.strapi.log as unknown as Record<string, (...args: unknown[]) => void>;
    for (const level of ["error", "warn", "info", "debug", "http"]) {
      const original = log[level]?.bind(log);
      if (!original) continue;
      log[level] = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
        original(...args);
      };
    }
  });
  afterAll(async () => {
    await t?.stop();
  });
  beforeEach(() => shares.__resetCreateLimiterForTest());

  const api = (caller: Caller, path: string, init?: Parameters<TestStrapi["api"]>[2]) =>
    t.api<Body>(caller, path, init) as Promise<ApiResponse<Body>>;
  const as = async (user: CreatedUser): Promise<Caller> => ({ jwt: await signIn(t, user) });
  const create = (caller: Caller, recipient: number, text: string, lifetime = "1h") =>
    api(caller, "/api/secret-shares", { json: { recipient, text, lifetime } });
  const reveal = (caller: Caller, id: string) =>
    api(caller, `/api/secret-shares/${id}/reveal`, { method: "POST" });
  const revoke = (caller: Caller, id: string) =>
    api(caller, `/api/secret-shares/${id}/revoke`, { method: "POST" });
  const stored = async (documentId: string) =>
    (await t.strapi.db.query(UID).findOne({ where: { documentId } })) as Row | null;
  const notifications = (documentId: string) =>
    t.strapi.db
      .query(NOTIFICATION)
      .count({ where: { type: "secretShared", link: `/secrets/${documentId}` } });
  const code = (res: ApiResponse<Body>) => res.body?.error?.details?.code;
  const sentinel = () => `SENTINEL-${randomBytes(9).toString("hex")}`;

  /** Two fresh staff members: a sender and a recipient. */
  async function pair(senderRole: TestRole = "member", recipientRole: TestRole = "member") {
    const sender = await createUser(t, senderRole);
    const recipient = await createUser(t, recipientRole);
    return { sender, recipient, from: await as(sender), to: await as(recipient) };
  }

  async function shared(text = "hunter2") {
    const p = await pair();
    const res = await create(p.from, p.recipient.id, text);
    expect(res.status, res.text).toBe(201);
    return { ...p, id: res.body.data!.id as string, text };
  }

  /** Every text value of every table of this boot, for the sentinel search. */
  async function everyTable(): Promise<string> {
    const tables =
      engine === "sqlite"
        ? (
            await t.database.sql<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
          ).map((row) => row.name)
        : (
            await t.database.sql<{ name: string }>(
              "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?",
              [t.database.env.DATABASE_SCHEMA],
            )
          ).map((row) => row.name);
    const dump: string[] = [];
    for (const table of tables) {
      dump.push(JSON.stringify(await t.database.sql(`SELECT * FROM "${table}"`)));
    }
    return dump.join("\n");
  }

  describe("who may call", () => {
    it("refuses guest, authenticated, anonymous callers and API tokens on every route", async () => {
      const { id } = await shared();
      const routes: [string, string][] = [
        ["GET", "/api/secret-shares"],
        ["POST", "/api/secret-shares"],
        ["GET", "/api/secret-shares/recipients"],
        ["GET", `/api/secret-shares/${id}`],
        ["POST", `/api/secret-shares/${id}/reveal`],
        ["POST", `/api/secret-shares/${id}/revoke`],
      ];
      const tokens = t.strapi as unknown as {
        service(uid: string): { create(input: object): Promise<{ accessKey: string }> };
      };
      const apiToken = (
        await tokens.service("admin::api-token").create({
          name: `it-secrets-${engine}`,
          type: "full-access",
          lifespan: null,
          description: "",
        })
      ).accessKey;
      for (const [method, path] of routes) {
        for (const caller of ["guest", "authenticated", null] as const) {
          const res = await api(caller, path, { method, json: method === "POST" ? {} : undefined });
          expect([401, 403], `${caller} ${method} ${path}`).toContain(res.status);
          expect(res.headers.get("cache-control"), path).toBe("private, no-store");
        }
        const token = await api({ jwt: apiToken }, path, {
          method,
          json: method === "POST" ? {} : undefined,
        });
        expect(token.status, `api token ${method} ${path}`).toBe(401);
      }
      expect((await stored(id))?.state).toBe("pending");
    });

    it("answers every staff role; another employee and the moderators get 404", async () => {
      const { id, sender, recipient, from, to } = await shared();
      for (const caller of [from, to]) {
        const res = await api(caller, `/api/secret-shares/${id}`);
        expect(res.status, res.text).toBe(200);
      }
      expect((await api(from, `/api/secret-shares/${id}`)).body.data).toMatchObject({
        id,
        direction: "sent",
        state: "pending",
        available: true,
        counterpart: { displayName: recipient.displayName, blocked: false },
      });
      expect((await api(to, `/api/secret-shares/${id}`)).body.data).toMatchObject({
        direction: "received",
        counterpart: { displayName: sender.displayName, blocked: false },
      });
      for (const role of [
        "admin_role",
        "editor",
        "department_head",
        "team_lead",
        "member",
      ] as const) {
        expect((await api(role, `/api/secret-shares/${id}`)).status, role).toBe(404);
        expect((await reveal(role, id)).status, role).toBe(404);
        expect((await revoke(role, id)).status, role).toBe(404);
        expect((await api(role, "/api/secret-shares")).status, role).toBe(200);
      }
      // The sender cannot open it, the recipient cannot revoke it.
      expect((await reveal(from, id)).status).toBe(404);
      expect((await revoke(to, id)).status).toBe(404);
      expect((await stored(id))?.state).toBe("pending");
    });

    it("refuses populate, filters, sort and fields, and malformed ids, with 400 or 404", async () => {
      const { id, from } = await shared();
      for (const query of [
        "populate=*",
        "filters[state]=pending",
        "sort=id",
        "fields[0]=envelope",
      ]) {
        expect((await api(from, `/api/secret-shares?${query}`)).status, query).toBe(400);
        expect((await api(from, `/api/secret-shares/${id}?${query}`)).status, query).toBe(400);
        expect((await api(from, `/api/secret-shares/recipients?${query}`)).status, query).toBe(400);
      }
      for (const page of ["0", "-1", "abc", "101", "1.5"]) {
        expect((await api(from, `/api/secret-shares?sentPage=${page}`)).status, page).toBe(400);
      }
      for (const bad of ["1", "x", `${id}x`, "ABCDEFGHIJKLMNOPQRSTUVWX"]) {
        expect((await api(from, `/api/secret-shares/${bad}`)).status, bad).toBe(404);
        expect((await reveal(from, bad)).status, bad).toBe(404);
      }
      expect((await stored(id))?.state).toBe("pending");
    });
  });

  describe("create, read once, revoke", () => {
    it("stores only the envelope, notifies the recipient and opens exactly once", async () => {
      const text = sentinel();
      const { id, recipient, from, to } = await shared(text);
      const row = (await t.strapi.db.query(UID).findOne({
        where: { documentId: id },
        select: ["state", "envelope", "senderId", "recipientId", "expiresAt", "terminalAt"],
      })) as Row;
      expect(row.state).toBe("pending");
      expect(String(row.envelope)).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(await notifications(id)).toBe(1);
      const bell = (await t.strapi.db.query(NOTIFICATION).findOne({
        where: { type: "secretShared", link: `/secrets/${id}` },
        populate: { recipient: true },
      })) as Row & { recipient?: { id: number } };
      expect(bell.recipient?.id).toBe(recipient.id);
      expect(bell.sourceType ?? null).toBeNull();

      const inbox = await api(to, "/api/secret-shares");
      expect(inbox.headers.get("cache-control")).toBe("private, no-store");
      expect(inbox.body.data?.received?.map((s) => s.id)).toContain(id);
      expect(JSON.stringify(inbox.body)).not.toContain("envelope");
      const sent = await api(from, "/api/secret-shares");
      expect(sent.body.data?.sent?.find((s) => s.id === id)).toMatchObject({ state: "pending" });

      const opened = await reveal(to, id);
      expect(opened.status, opened.text).toBe(200);
      expect(opened.body.data?.text).toBe(text);
      expect(opened.headers.get("cache-control")).toBe("private, no-store");
      const after = (await t.strapi.db.query(UID).findOne({
        where: { documentId: id },
        select: ["state", "envelope", "terminalAt"],
      })) as Row;
      expect(after.state).toBe("retrieved");
      expect(after.envelope ?? null).toBeNull();
      expect(after.terminalAt).not.toBeNull();
      expect(await notifications(id)).toBe(0);

      const again = await reveal(to, id);
      expect(again.status).toBe(410);
      expect(code(again)).toBe("gone");
      expect(again.text).not.toContain(text);
      expect((await api(from, `/api/secret-shares/${id}`)).body.data).toMatchObject({
        state: "retrieved",
        available: false,
      });
      expect(
        (await api(to, "/api/secret-shares")).body.data?.received?.map((s) => s.id),
      ).not.toContain(id);
    });

    it("revokes while pending; afterwards reveal and revoke answer gone", async () => {
      const { id, from, to } = await shared();
      const res = await revoke(from, id);
      expect(res.status, res.text).toBe(200);
      expect(res.body.data).toEqual({ id });
      const row = (await t.strapi.db.query(UID).findOne({
        where: { documentId: id },
        select: ["state", "envelope"],
      })) as Row;
      expect(row).toMatchObject({ state: "revoked" });
      expect(row.envelope ?? null).toBeNull();
      expect(await notifications(id)).toBe(0);
      expect(code(await reveal(to, id))).toBe("gone");
      expect(code(await revoke(from, id))).toBe("gone");
    });

    it("refuses bad input with fixed codes and never echoes the text", async () => {
      const { recipient, sender, from } = await pair();
      const text = sentinel();
      const cases: [Record<string, unknown>, string][] = [
        [{ recipient: sender.id, text, lifetime: "1h" }, "recipient"],
        [{ recipient: "abc", text, lifetime: "1h" }, "recipient"],
        [{ recipient: recipient.id, text: "  ", lifetime: "1h" }, "text"],
        [{ recipient: recipient.id, text: `${text}${"ä".repeat(4096)}`, lifetime: "1h" }, "text"],
        [{ recipient: recipient.id, text: `${text}\ud800`, lifetime: "1h" }, "text"],
        [{ recipient: recipient.id, text, lifetime: "7d" }, "lifetime"],
      ];
      for (const [json, expected] of cases) {
        const res = await api(from, "/api/secret-shares", { json });
        expect(res.status, JSON.stringify(json).slice(0, 80)).toBe(400);
        expect(code(res)).toBe(expected);
        expect(res.text).not.toContain(text);
      }
      // Guests, `authenticated` and blocked people are no recipients.
      for (const role of ["guest", "authenticated"] as const) {
        const res = await create(from, t.fixtures.users[role].id, text);
        expect(code(res), role).toBe("recipient");
      }
      const blocked = await createUser(t, "member");
      await t.strapi.db.query(USER).update({ where: { id: blocked.id }, data: { blocked: true } });
      expect(code(await create(from, blocked.id, text))).toBe("recipient");
      expect(code(await create(from, 2_000_000_000, text))).toBe("recipient");
      // A malformed body: no text in the answer either.
      const raw = await fetch(`${t.baseUrl}/api/secret-shares`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${(from as { jwt: string }).jwt}`,
          "content-type": "application/json",
        },
        body: `{"recipient": ${recipient.id}, "text": "${text}`,
      });
      expect(raw.status).toBe(400);
      expect(raw.headers.get("cache-control")).toBe("private, no-store");
      expect(await raw.text()).not.toContain(text);
      expect(await t.strapi.db.query(UID).count({ where: { senderId: sender.id } })).toBe(0);
    });

    it("lists the eligible staff as recipients, never the caller, guests or blocked people", async () => {
      const { sender, recipient, from } = await pair();
      const res = await api(from, `/api/secret-shares/recipients?q=${encodeURIComponent("Extra")}`);
      expect(res.status, res.text).toBe(200);
      const ids = (res.body.data as unknown as { id: number }[]).map((r) => r.id);
      expect(ids).not.toContain(sender.id);
      expect(ids.length).toBeLessThanOrEqual(20);
      const one = await api(
        from,
        `/api/secret-shares/recipients?q=${encodeURIComponent(recipient.displayName)}`,
      );
      expect(one.body.data).toEqual([
        { id: recipient.id, displayName: recipient.displayName, department: null },
      ]);
      const guest = await api(from, `/api/secret-shares/recipients?q=Fixture%20guest`);
      expect(guest.body.data).toEqual([]);
      expect((await api(from, `/api/secret-shares/recipients?q=${"x".repeat(101)}`)).status).toBe(
        400,
      );
    });
  });

  describe("races and limits", () => {
    it("exactly one of five concurrent reveals gets the text", async () => {
      const { id, to, text } = await shared();
      const answers = await Promise.all(Array.from({ length: 5 }, () => reveal(to, id)));
      const opened = answers.filter((res) => res.status === 200);
      expect(opened).toHaveLength(1);
      expect(opened[0].body.data?.text).toBe(text);
      for (const res of answers.filter((r) => r.status !== 200)) {
        expect(["gone", "busy"]).toContain(code(res));
      }
      expect((await stored(id))?.state).toBe("retrieved");
    });

    it("a reveal racing a revoke: one of them wins, never both", async () => {
      const { id, from, to, text } = await shared();
      const [opened, revoked] = await Promise.all([reveal(to, id), revoke(from, id)]);
      const state = (await stored(id))?.state;
      if (opened.status === 200) {
        expect(opened.body.data?.text).toBe(text);
        expect(state).toBe("retrieved");
        expect(revoked.status).not.toBe(200);
      } else {
        expect(opened.text).not.toContain(text);
        expect(revoked.status).toBe(200);
        expect(state).toBe("revoked");
      }
    });

    it("caps the sender's pending shares under concurrent creates", async () => {
      const sender = await createUser(t, "member");
      const from = await as(sender);
      for (let i = 0; i < SECRET_PENDING_PER_SENDER - 1; i++) {
        if (i % 9 === 0) shares.__resetCreateLimiterForTest();
        const recipient = await createUser(t, "member");
        expect((await create(from, recipient.id, `n${i}`)).status).toBe(201);
      }
      shares.__resetCreateLimiterForTest();
      const others = await Promise.all(Array.from({ length: 5 }, () => createUser(t, "member")));
      const answers = await Promise.all(others.map((o) => create(from, o.id, "last")));
      expect(answers.filter((res) => res.status === 201)).toHaveLength(1);
      for (const res of answers.filter((r) => r.status !== 201)) {
        expect(res.status).toBe(429);
        expect(code(res)).toBe("quota");
      }
      expect(
        await t.strapi.db.query(UID).count({ where: { senderId: sender.id, state: "pending" } }),
      ).toBe(SECRET_PENDING_PER_SENDER);
    });

    it("limits creates per minute and per day", async () => {
      const { sender, recipient, from } = await pair();
      const answers: number[] = [];
      for (let i = 0; i < 11; i++) {
        answers.push((await create(from, recipient.id, `m${i}`)).status);
      }
      // The recipient's pending cap is 20, so only the minute limiter refuses.
      expect(answers.slice(0, 10).every((s) => s === 201)).toBe(true);
      expect(answers[10]).toBe(429);
      shares.__resetCreateLimiterForTest();
      // The daily cap counts every state: ended rows of today fill it.
      const today = new Date();
      for (let i = 0; i < SECRET_CREATES_PER_DAY - 10; i++) {
        await t.strapi.db.query(UID).create({
          data: {
            senderId: sender.id,
            recipientId: recipient.id,
            expiresAt: today,
            state: "retrieved",
            terminalAt: today,
          },
        });
      }
      const other = await createUser(t, "member");
      const day = await create(from, other.id, "one too many");
      expect(day.status).toBe(429);
      expect(code(day)).toBe("quota");
    });
  });

  describe("eligibility, expiry, keys and the janitor", () => {
    it("a blocked sender: unavailable (409) and out of the inbox while blocked, opens after the unblock", async () => {
      const { id, sender, from, to, text } = await shared();
      await t.strapi.db.query(USER).update({ where: { id: sender.id }, data: { blocked: true } });
      expect(
        (await api(to, "/api/secret-shares")).body.data?.received?.map((s) => s.id),
      ).not.toContain(id);
      expect((await api(to, `/api/secret-shares/${id}`)).body.data).toMatchObject({
        state: "pending",
        available: false,
        counterpart: { blocked: true },
      });
      const refused = await reveal(to, id);
      expect(refused.status).toBe(409);
      expect(code(refused)).toBe("unavailable");
      expect((await stored(id))?.state).toBe("pending");
      await t.strapi.db.query(USER).update({ where: { id: sender.id }, data: { blocked: false } });
      expect((await reveal(to, id)).body.data?.text).toBe(text);
      void from;
    });

    it("the janitor cancels the shares of a blocked or demoted party, expires and deletes", async () => {
      const blockedCase = await shared();
      const demotedCase = await shared();
      const expiredCase = await shared();
      await t.strapi.db
        .query(USER)
        .update({ where: { id: blockedCase.recipient.id }, data: { blocked: true } });
      const guestRole = (await t.strapi.db
        .query("plugin::users-permissions.role")
        .findOne({ where: { type: "guest" } })) as Row;
      await t.strapi.db
        .query(USER)
        .update({ where: { id: demotedCase.sender.id }, data: { role: guestRole.id } });
      await t.strapi.db.query(UID).update({
        where: { documentId: expiredCase.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      // Expiry is checked before the envelope: the moved expiry no longer matches it.
      expect(code(await reveal(expiredCase.to, expiredCase.id))).toBe("gone");
      await janitor.runSecretShareJanitor(t.strapi);
      for (const [c, state] of [
        [blockedCase, "cancelled"],
        [demotedCase, "cancelled"],
        [expiredCase, "expired"],
      ] as const) {
        const row = (await t.strapi.db.query(UID).findOne({
          where: { documentId: c.id },
          select: ["state", "envelope", "terminalAt"],
        })) as Row;
        expect(row.state, c.id).toBe(state);
        expect(row.envelope ?? null).toBeNull();
        expect(row.terminalAt).not.toBeNull();
        expect(await notifications(c.id)).toBe(0);
      }
      // Ended rows go after the retention.
      await t.strapi.db.query(UID).update({
        where: { documentId: expiredCase.id },
        data: { terminalAt: new Date(Date.now() - SECRET_SHARE_RETENTION_MS - 1000) },
      });
      await janitor.runSecretShareJanitor(t.strapi);
      expect(await stored(expiredCase.id)).toBeNull();
      expect(await stored(blockedCase.id)).not.toBeNull();
    });

    it("the janitor deletes the shares of a removed account in every state, also with the module off", async () => {
      const pending = await shared();
      const retrieved = await shared();
      expect((await reveal(retrieved.to, retrieved.id)).status).toBe(200);
      const previous = process.env.FEATURES_OFF;
      process.env.FEATURES_OFF = "secrets";
      try {
        const off = await api(pending.to, "/api/secret-shares");
        expect(off.status).toBe(404);
        expect(off.headers.get("cache-control")).toBe("private, no-store");
        expect((await reveal(pending.to, pending.id)).status).toBe(404);
        await t.strapi.db.query(USER).delete({ where: { id: pending.sender.id } });
        await t.strapi.db.query(USER).delete({ where: { id: retrieved.recipient.id } });
        // Reveal refuses an orphan at once (the sender is gone).
        process.env.FEATURES_OFF = previous ?? "";
        expect(code(await reveal(pending.to, pending.id))).toBe("gone");
        process.env.FEATURES_OFF = "secrets";
        await janitor.runSecretShareJanitor(t.strapi);
      } finally {
        if (previous === undefined) delete process.env.FEATURES_OFF;
        else process.env.FEATURES_OFF = previous;
      }
      expect(await stored(pending.id)).toBeNull();
      expect(await stored(retrieved.id)).toBeNull();
      expect(await notifications(pending.id)).toBe(0);
    });

    it("an envelope under another key turns the share cancelled, never retrieved", async () => {
      const { id, to } = await shared();
      const crypto = t.requireBuilt<CryptoModule>("src/utils/secret-crypto");
      const original = t.strapi.config.get("admin.secrets.encryptionKey");
      crypto.configureShareKey(randomBytes(32).toString("hex"), true, { error: () => undefined });
      try {
        const res = await reveal(to, id);
        expect(res.status).toBe(410);
        expect(code(res)).toBe("unavailable");
      } finally {
        crypto.configureShareKey(original, true, { error: () => undefined });
      }
      const row = (await t.strapi.db.query(UID).findOne({
        where: { documentId: id },
        select: ["state", "envelope"],
      })) as Row;
      expect(row.state).toBe("cancelled");
      expect(row.envelope ?? null).toBeNull();
      expect(await notifications(id)).toBe(0);
    });

    it("without a usable key the module answers unavailable (503)", async () => {
      const { id, to, from, recipient } = await shared();
      const crypto = t.requireBuilt<CryptoModule>("src/utils/secret-crypto");
      const original = t.strapi.config.get("admin.secrets.encryptionKey");
      crypto.configureShareKey("short", true, { error: () => undefined });
      try {
        for (const res of [await reveal(to, id), await create(from, recipient.id, "x")]) {
          expect(res.status).toBe(503);
          expect(code(res)).toBe("unavailable");
        }
      } finally {
        crypto.configureShareKey(original, true, { error: () => undefined });
      }
      expect((await stored(id))?.state).toBe("pending");
    });
  });

  describe("data protection", () => {
    it("exports the metadata of both directions, also for an admin_role, never the content", async () => {
      const text = sentinel();
      const { sender, recipient, from, to, id } = await shared(text);
      await reveal(to, id);
      const res = await api("admin_role", `/api/user-management/${sender.id}/export`);
      expect(res.status, res.text).toBe(200);
      const content = ((res.body.data ?? res.body) as unknown as { content: Record<string, Row[]> })
        .content;
      expect(content.secretSharesSent).toEqual([
        expect.objectContaining({ to: recipient.displayName, state: "retrieved" }),
      ]);
      expect(content.secretSharesReceived).toEqual([]);
      expect(res.text).not.toContain(text);
      expect(res.text).not.toContain("envelope");
      const theirs = await api("admin_role", `/api/user-management/${recipient.id}/export`);
      expect(
        ((theirs.body.data ?? theirs.body) as unknown as { content: Record<string, Row[]> }).content
          .secretSharesReceived,
      ).toEqual([expect.objectContaining({ from: sender.displayName, state: "retrieved" })]);
      void from;
    });

    it("anonymisation deletes every share of the person and their notifications; the preview counts them", async () => {
      const sent = await shared();
      const received = await createUser(t, "member");
      const other = await createUser(t, "member");
      const otherCaller = await as(other);
      const incoming = await create(otherCaller, sent.sender.id, "to the leaver");
      expect(incoming.status).toBe(201);
      const person = sent.sender;
      await t.strapi.db.query(USER).update({ where: { id: person.id }, data: { blocked: true } });
      const preview = await api("admin_role", `/api/user-management/${person.id}/anonymise`);
      expect(preview.status, preview.text).toBe(200);
      const counts = (
        preview.body.data as unknown as { counts: { deleted: Record<string, number> } }
      ).counts;
      expect(counts.deleted.secretShares).toBe(2);
      const run = await api("admin_role", `/api/user-management/${person.id}/anonymise`, {
        json: { confirm: person.username },
      });
      expect(run.status, run.text).toBe(200);
      expect(await stored(sent.id)).toBeNull();
      expect(await stored(incoming.body.data!.id as string)).toBeNull();
      expect(await notifications(sent.id)).toBe(0);
      expect(
        await t.strapi.db.query(UID).count({
          where: { $or: [{ senderId: person.id }, { recipientId: person.id }] },
        }),
      ).toBe(0);
      void received;
    });

    it("the erasure sweep deletes a share written for an anonymised person after the run", async () => {
      const { sender, recipient } = await pair();
      await t.strapi.db.query(USER).update({
        where: { id: sender.id },
        data: { blocked: true, anonymisedAt: new Date().toISOString() },
      });
      await t.strapi.db.query(UID).create({
        data: {
          senderId: sender.id,
          recipientId: recipient.id,
          expiresAt: new Date(Date.now() + 60_000),
          state: "pending",
        },
      });
      const sweep = t.requireBuilt<{ sweepAnonymised(s: unknown): Promise<unknown> }>(
        "src/utils/anonymise",
      );
      await sweep.sweepAnonymised(t.strapi);
      expect(await t.strapi.db.query(UID).count({ where: { senderId: sender.id } })).toBe(0);
    });
  });

  it("the sentinel text is nowhere after create and reveal: no table, no log line, no notification", async () => {
    const text = sentinel();
    const { id, to, from, recipient } = await shared(text);
    // Refusals that carry the sentinel in their request.
    await create(from, recipient.id, `${text}${"x".repeat(9000)}`);
    await create(from, recipient.id, `${text}\ud800`);
    await fetch(`${t.baseUrl}/api/secret-shares`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${(from as { jwt: string }).jwt}`,
        "content-type": "application/json",
      },
      body: `{"text": "${text}`,
    });
    expect((await everyTable()).includes(text)).toBe(false);
    expect((await reveal(to, id)).body.data?.text).toBe(text);
    expect((await everyTable()).includes(text)).toBe(false);
    expect(logged.filter((line) => line.includes(text))).toEqual([]);
  });

  it("the fixture roles are all here (sanity)", () => {
    expect(Object.keys(t.fixtures.users).sort()).toEqual([...TEST_ROLES].sort());
    vi.restoreAllMocks();
  });
});
