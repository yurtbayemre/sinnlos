import { errors } from "@strapi/utils";
import { describe, expect, it, vi } from "vitest";

import { loadContentTypeSchemas } from "../test/strapi-stub.test.helper";
import { NotPublishableError } from "./publish-readiness";
import {
  SCHEDULE_ERROR_CODES,
  SCHEDULE_TRANSIENT_ATTEMPTS,
  TransientAttempts,
  WITHDRAWAL_BACKOFF_MINUTES,
  classifyScheduleFailure,
  createScheduleClear,
  describeFailure,
  instantOf,
  windowEnd,
  windowExpired,
  type ScheduleClearHost,
} from "./schedule";

/** Scheduled publishing (decision 06 §D): the decisions and schedule-clear (rule 6). */

const ANNOUNCEMENT = "api::announcement.announcement";
const EVENT = "api::event.event";
const DOCUMENT = "api::document.document";
const QUICK_LINK = "api::quick-link.quick-link";
const POLL = "api::poll.poll";
const SCHEMAS = loadContentTypeSchemas();

const NOW = new Date("2026-11-02T09:00:00.000Z");
const BEFORE = "2026-11-02T08:59:59.000Z";
const AFTER = "2026-11-02T09:00:01.000Z";

describe("the vocabulary", () => {
  it("names five schedule error codes and a retry bound of 5", () => {
    expect(SCHEDULE_ERROR_CODES).toEqual([
      "notPublishable",
      "invalid",
      "rejected",
      "windowExpired",
      "retryExhausted",
    ]);
    expect(SCHEDULE_TRANSIENT_ATTEMPTS).toBe(5);
  });
});

describe("the expired window (rule 5)", () => {
  it("ends at the announcement's expiresAt and at unpublishAt on documents and quick links", () => {
    expect(windowEnd(ANNOUNCEMENT, { expiresAt: BEFORE })?.toISOString()).toBe(BEFORE);
    expect(windowEnd(DOCUMENT, { unpublishAt: AFTER })?.toISOString()).toBe(AFTER);
    expect(windowEnd(QUICK_LINK, { unpublishAt: null })).toBeNull();
    // Events, wiki pages, courses and lessons have no window.
    expect(windowEnd(EVENT, { expiresAt: BEFORE, unpublishAt: BEFORE })).toBeNull();
    // An announcement's unpublishAt does not exist; only expiresAt counts.
    expect(windowEnd(ANNOUNCEMENT, { unpublishAt: BEFORE })).toBeNull();
  });

  it("has expired when its end is at or before now", () => {
    expect(windowExpired(ANNOUNCEMENT, { expiresAt: BEFORE }, NOW)).toBe(true);
    expect(windowExpired(ANNOUNCEMENT, { expiresAt: NOW.toISOString() }, NOW)).toBe(true);
    expect(windowExpired(ANNOUNCEMENT, { expiresAt: AFTER }, NOW)).toBe(false);
    expect(windowExpired(QUICK_LINK, { unpublishAt: new Date(BEFORE) }, NOW)).toBe(true);
    expect(windowExpired(QUICK_LINK, {}, NOW)).toBe(false);
  });

  it("reads instants as strings or dates, never garbage", () => {
    expect(instantOf(BEFORE)?.toISOString()).toBe(BEFORE);
    expect(instantOf(new Date(BEFORE))?.toISOString()).toBe(BEFORE);
    expect(instantOf("not a date")).toBeNull();
    expect(instantOf("")).toBeNull();
    expect(instantOf(null)).toBeNull();
  });
});

describe("failure classification (rule 7)", () => {
  it("permanent: readiness, validation, a lifecycle's ApplicationError", () => {
    expect(classifyScheduleFailure(new NotPublishableError(["title"]))).toMatchObject({
      kind: "permanent",
      code: "notPublishable",
    });
    expect(
      classifyScheduleFailure(new errors.ValidationError("title must be defined")),
    ).toMatchObject({
      kind: "permanent",
      code: "invalid",
    });
    expect(classifyScheduleFailure(new errors.ApplicationError("Kurs fehlt"))).toMatchObject({
      kind: "permanent",
      code: "rejected",
      // Never the message (a lifecycle may quote a value): the class only.
      detail: "ApplicationError",
    });
  });

  it("transient: deadlocks, lock timeouts, lost connections, SQLITE_BUSY and anything unknown", () => {
    const coded = (code: string) => Object.assign(new Error(`failed ${code}`), { code });
    for (const code of [
      "40P01",
      "40001",
      "55P03",
      "57014",
      "57P01",
      "08006",
      "ECONNRESET",
      "SQLITE_BUSY",
    ]) {
      expect(classifyScheduleFailure(coded(code)), code).toMatchObject({ kind: "transient" });
    }
    expect(classifyScheduleFailure(new TypeError("boom"))).toMatchObject({ kind: "transient" });
    expect(classifyScheduleFailure("a string")).toEqual({ kind: "transient", detail: "string" });
  });

  it("names no content in the detail: class, driver code and field names only", () => {
    // knex builds a database error's message from the SQL with its bound values.
    const leaky = Object.assign(
      new Error(
        `insert into "announcements" ("title","body") values ('Secret title', 'Secret body') - value too long`,
      ),
      { code: "22001" },
    );
    expect(classifyScheduleFailure(leaky)).toEqual({ kind: "transient", detail: "Error 22001" });
    expect(describeFailure(leaky)).not.toMatch(/Secret/);
    const yup = new errors.ValidationError(
      'title must be a `string` type, but the final value was: `"Secret"`',
      {
        errors: [{ path: ["title"], message: "Secret" }],
      },
    );
    expect(classifyScheduleFailure(yup)).toEqual({
      kind: "permanent",
      code: "invalid",
      detail: "ValidationError: title",
    });
    expect(classifyScheduleFailure(new NotPublishableError(["course", "title"])).detail).toBe(
      "keys: course, title",
    );
    expect(describeFailure("a string with Secret")).toBe("string");
  });
});

describe("transient attempts (rule 7)", () => {
  it("counts per (uid, documentId, revision) and reports the bound", () => {
    const attempts = new TransientAttempts(3);
    expect(attempts.fail(ANNOUNCEMENT, "a", 4)).toBe(false);
    expect(attempts.fail(ANNOUNCEMENT, "a", 4)).toBe(false);
    // Another revision or document counts on its own.
    expect(attempts.fail(ANNOUNCEMENT, "a", 5)).toBe(false);
    expect(attempts.fail(EVENT, "a", 4)).toBe(false);
    expect(attempts.fail(ANNOUNCEMENT, "a", 4)).toBe(true);
    attempts.clear(ANNOUNCEMENT, "a", 4);
    expect(attempts.fail(ANNOUNCEMENT, "a", 4)).toBe(false);
  });

  it("counts the publish and the unpublish pass apart", () => {
    const attempts = new TransientAttempts(2);
    expect(attempts.fail(DOCUMENT, "d", 1, "unpublish")).toBe(false);
    expect(attempts.fail(DOCUMENT, "d", 1, "publish")).toBe(false);
    expect(attempts.fail(DOCUMENT, "d", 1, "unpublish")).toBe(true);
  });

  it("stays bounded in memory", () => {
    const attempts = new TransientAttempts(5, 3);
    for (const id of ["a", "b", "c", "d", "e"]) attempts.fail(ANNOUNCEMENT, id, 1);
    expect(attempts.size).toBe(3);
  });

  it("defers a failed withdrawal by 5, 15, then every 60 minutes; a new revision or success ends it", () => {
    const attempts = new TransientAttempts();
    const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
    expect(WITHDRAWAL_BACKOFF_MINUTES).toEqual([5, 15, 60]);
    expect(attempts.withdrawalReady(QUICK_LINK, "q", NOW, 3)).toBe(true);

    expect(attempts.deferWithdrawal(QUICK_LINK, "q", NOW, 3)).toEqual(minutes(5));
    expect(attempts.withdrawalFailures(QUICK_LINK, "q")).toBe(1);
    expect(attempts.withdrawalReady(QUICK_LINK, "q", minutes(4), 3)).toBe(false);
    expect(attempts.withdrawalReady(QUICK_LINK, "q", minutes(5), 3)).toBe(true);
    // The document changed since the failure: ready at once.
    expect(attempts.withdrawalReady(QUICK_LINK, "q", minutes(1), 4)).toBe(true);
    // Another document is not deferred.
    expect(attempts.withdrawalReady(DOCUMENT, "q", minutes(1), 3)).toBe(true);

    expect(attempts.deferWithdrawal(QUICK_LINK, "q", minutes(5), 3)).toEqual(minutes(20));
    expect(attempts.deferWithdrawal(QUICK_LINK, "q", minutes(20), 3)).toEqual(minutes(80));
    expect(attempts.deferWithdrawal(QUICK_LINK, "q", minutes(80), 3)).toEqual(minutes(140));
    expect(attempts.withdrawalFailures(QUICK_LINK, "q")).toBe(4);

    attempts.clearWithdrawal(QUICK_LINK, "q");
    expect(attempts.withdrawalFailures(QUICK_LINK, "q")).toBe(0);
    expect(attempts.withdrawalReady(QUICK_LINK, "q", minutes(81), 3)).toBe(true);
  });

  it("keeps the deferred withdrawals bounded in memory too", () => {
    const attempts = new TransientAttempts(5, 2);
    for (const id of ["a", "b", "c"]) attempts.deferWithdrawal(QUICK_LINK, id, NOW, 1);
    expect(attempts.withdrawalFailures(QUICK_LINK, "a")).toBe(0);
    expect(attempts.withdrawalFailures(QUICK_LINK, "c")).toBe(1);
  });
});

describe("schedule-clear (rule 6)", () => {
  function host() {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const query = vi.fn(() => ({ updateMany }));
    const strapi: ScheduleClearHost = { db: { query } };
    return { strapi, query, updateMany };
  }
  const contentType = (uid: string) => ({ attributes: SCHEMAS[uid]?.attributes ?? {} });

  async function run(uid: string, action: string, params: Record<string, unknown>) {
    const h = host();
    const next = vi.fn(async () => "done");
    const context = { uid, action, params, contentType: contentType(uid) };
    await expect(createScheduleClear(h.strapi)(context, next)).resolves.toBe("done");
    expect(next).toHaveBeenCalledTimes(1);
    return { ...h, context };
  }

  it("a publish clears the draft's publishAt and scheduleError before the copy", async () => {
    const { query, updateMany } = await run(DOCUMENT, "publish", { documentId: "d1" });
    expect(query).toHaveBeenCalledWith(DOCUMENT);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        documentId: "d1",
        publishedAt: null,
        $or: [{ publishAt: { $notNull: true } }, { scheduleError: { $notNull: true } }],
      },
      data: { publishAt: null, scheduleError: null },
    });
  });

  it("an unpublish clears the draft's publishAt only (a withdrawal cancels a pending publish)", async () => {
    const { updateMany } = await run(ANNOUNCEMENT, "unpublish", { documentId: "a1" });
    expect(updateMany).toHaveBeenCalledWith({
      where: { documentId: "a1", publishedAt: null, $or: [{ publishAt: { $notNull: true } }] },
      data: { publishAt: null },
    });
  });

  it("create and update with status published write the schedule as null; unpublishAt stays", async () => {
    for (const action of ["create", "update"]) {
      const { context, updateMany } = await run(QUICK_LINK, action, {
        documentId: "q1",
        status: "published",
        data: { label: "L", publishAt: AFTER, unpublishAt: AFTER, scheduleError: "invalid" },
      });
      expect(context.params.data).toEqual({
        label: "L",
        publishAt: null,
        unpublishAt: AFTER,
        scheduleError: null,
      });
      expect(updateMany).not.toHaveBeenCalled();
    }
  });

  it("a draft save keeps its schedule and clears scheduleError", async () => {
    const { context } = await run(EVENT, "update", {
      documentId: "e1",
      status: "draft",
      data: { title: "T", publishAt: AFTER },
    });
    expect(context.params.data).toEqual({ title: "T", publishAt: AFTER, scheduleError: null });
    const created = await run(EVENT, "create", { data: { title: "T" } });
    expect(created.context.params.data).toEqual({ title: "T", scheduleError: null });
  });

  it("a clone starts unscheduled (only the fields the type has)", async () => {
    const document = await run(DOCUMENT, "clone", { documentId: "d1", data: { title: "Copy" } });
    expect(document.context.params.data).toEqual({
      title: "Copy",
      publishAt: null,
      unpublishAt: null,
      scheduleError: null,
    });
    const announcement = await run(ANNOUNCEMENT, "clone", { documentId: "a1" });
    expect(announcement.context.params.data).toEqual({ publishAt: null, scheduleError: null });
  });

  it("a discard, a delete, a read and every unscheduled type pass untouched", async () => {
    for (const [uid, action] of [
      [ANNOUNCEMENT, "discardDraft"],
      [ANNOUNCEMENT, "delete"],
      [ANNOUNCEMENT, "findMany"],
      [POLL, "publish"],
      [POLL, "create"],
    ]) {
      const params = { documentId: "x", data: { question: "Q" } };
      const { updateMany, context } = await run(uid, action, params);
      expect(updateMany, `${uid} ${action}`).not.toHaveBeenCalled();
      expect(context.params.data, `${uid} ${action}`).toEqual({ question: "Q" });
    }
  });
});
