import { errors } from "@strapi/utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import auditLifecycles from "../api/audit-event/content-types/audit-event/lifecycles";
import { CONTENT_VERSION_INDEX, indexSql } from "../bootstrap/document-indexes";
import {
  appContentType,
  minimalType,
  openDocumentService,
  type OpenDocumentService,
  type TestMiddleware,
} from "../test/document-service.test.helper";
import { AUDIT_EVENT_UID, createAuditRecorder, type AuditHost } from "../utils/audit";
import {
  CONTENT_VERSION_UID,
  createDocumentLock,
  readRevision,
  type DocumentLockMiddlewareHost,
} from "../utils/document-lock";
import { createPublishReadiness, type PublishReadinessHost } from "../utils/publish-readiness";
import {
  SCHEDULE_BATCH,
  SCHEDULE_TRANSIENT_ATTEMPTS,
  TransientAttempts,
  WITHDRAWAL_RETRY_QUOTA,
  WITHDRAWAL_RETRY_SCAN,
  createScheduleClear,
  type ScheduleClearHost,
} from "../utils/schedule";
import {
  DEPENDENCY_WAIT_MINUTES,
  emptyResult,
  recordScheduleFailure,
  runScheduledDocument,
  runScheduledPublishing,
  type ScheduledPublishStrapi,
} from "./scheduled-publish";

/**
 * The scheduled publisher (decision 06 §D rules 2-13) on the real document
 * service and query engine (SQLite), with the document layer's middlewares
 * in their slot order. Two runners on separate connections and the admin
 * panel are in integration/scheduled-publish.
 */

const ANNOUNCEMENT = "api::announcement.announcement";
const EVENT = "api::event.event";
const DOCUMENT = "api::document.document";
const QUICK_LINK = "api::quick-link.quick-link";

const schedule = { publishAt: { type: "datetime" }, scheduleError: { type: "string" } };
const window = { unpublishAt: { type: "datetime" } };
const title = { title: { type: "string", required: true } };

let open: OpenDocumentService;
let strapi: ScheduledPublishStrapi;

const NOW = new Date("2026-11-02T09:00:00.000Z");
const PAST = "2026-11-02T08:59:00.000Z";
const EARLIER = "2026-11-02T08:30:00.000Z";
const FUTURE = "2026-11-02T09:01:00.000Z";

beforeEach(async () => {
  open = await openDocumentService([
    appContentType(CONTENT_VERSION_UID),
    appContentType(AUDIT_EVENT_UID),
    minimalType(ANNOUNCEMENT, "announcements", {
      ...title,
      expiresAt: { type: "datetime" },
      ...schedule,
    }),
    minimalType(EVENT, "events", { ...title, ...schedule }),
    minimalType(DOCUMENT, "documents", { ...title, ...schedule, ...window }),
    minimalType(QUICK_LINK, "quick_links", { label: { type: "string" }, ...schedule, ...window }),
    minimalType("api::wiki-page.wiki-page", "wiki_pages", {
      ...title,
      ...schedule,
      parent: { type: "relation", relation: "manyToOne", target: "api::wiki-page.wiki-page" },
    }),
    minimalType("api::course.course", "courses", { ...title, ...schedule }),
    minimalType("api::lesson.lesson", "lessons", { ...title, ...schedule }),
  ]);
  await open.db.connection.raw(
    indexSql("sqlite", "main", {
      name: CONTENT_VERSION_INDEX,
      table: "content_versions",
      columns: ["target_uid", "target_document_id"],
      unique: true,
    }),
  );
  (
    open.db as unknown as { lifecycles: { subscribe(subscriber: unknown): void } }
  ).lifecycles.subscribe({
    models: [AUDIT_EVENT_UID],
    ...auditLifecycles,
  });
  const host = open.strapi as unknown as DocumentLockMiddlewareHost &
    ScheduleClearHost &
    PublishReadinessHost &
    AuditHost;
  // The document layer's slots: lock, schedule-clear, readiness, audit.
  open.service.use(createDocumentLock(host) as TestMiddleware);
  open.service.use(createScheduleClear(host) as TestMiddleware);
  open.service.use(createPublishReadiness(host) as TestMiddleware);
  open.service.use(createAuditRecorder(host) as TestMiddleware);
  strapi = open.strapi as unknown as ScheduledPublishStrapi;
}, 30_000);

afterEach(async () => {
  await open.close();
});

const docs = (uid: string) => open.service(uid);

const rows = async (uid: string, documentId: string) =>
  (await open.db.query(uid).findMany({ where: { documentId }, orderBy: { id: "asc" } })).map(
    (row) => ({
      published: row.publishedAt !== null,
      publishAt: row.publishAt ?? null,
      unpublishAt: row.unpublishAt ?? null,
      scheduleError: row.scheduleError ?? null,
      updatedAt: row.updatedAt,
    }),
  );

const audit = async (documentId: string) =>
  (
    await open.db
      .query(AUDIT_EVENT_UID)
      .findMany({ where: { targetDocumentId: documentId }, orderBy: { id: "asc" } })
  ).map((row) => [row.action, row.source, row.revision, row.detail]);

const run = (now = NOW, attempts = new TransientAttempts()) =>
  runScheduledPublishing(strapi, now, attempts);

/**
 * Controlled reads for the refusal's re-check: inside the scheduler's
 * `transactionNo`-th outer transaction (the failure record), the first
 * "has a published row" count of `documentId` of `uid` answers what the
 * database says, every later one 1: the course or parent was published
 * between the blockers' read and the dependency read. Returns the undo.
 */
function publishedBetweenReads(
  db: {
    query(uid: string): unknown;
    transaction(callback: unknown): Promise<unknown>;
    inTransaction(): boolean;
  },
  uid: string,
  documentId: string,
  transactionNo = 2,
): () => void {
  const originalQuery = db.query;
  const originalTransaction = db.transaction;
  let outer = 0;
  let inRecord = false;
  let reads = 0;
  db.transaction = async function (this: unknown, callback: unknown) {
    if (!db.inTransaction()) {
      outer += 1;
      inRecord = outer === transactionNo;
    }
    return originalTransaction.call(db, callback);
  };
  db.query = function (this: unknown, name: string) {
    const query = originalQuery.call(db, name) as Record<string, unknown>;
    if (name !== uid) return query;
    return new Proxy(query, {
      get(target, prop) {
        const value = target[prop as string];
        if (prop !== "count" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (params: { where?: Record<string, unknown> }) => {
          const where = params?.where ?? {};
          const published =
            where.documentId === documentId &&
            typeof where.publishedAt === "object" &&
            where.publishedAt !== null &&
            "$notNull" in (where.publishedAt as object);
          if (inRecord && published) {
            reads += 1;
            if (reads > 1) return 1;
          }
          return (value as (p: unknown) => Promise<number>).call(target, params);
        };
      },
    });
  };
  return () => {
    db.query = originalQuery;
    db.transaction = originalTransaction;
  };
}

/**
 * Runs `between` just before the `n`-th transaction the scheduler opens
 * outside any other one (its document locks are taken inside those): the
 * window between what a run read and the lock it acts under. Writes made
 * by `between` itself are not counted. Returns the undo.
 */
function pauseBeforeTransaction(n: number, between: () => Promise<void>): () => void {
  const db = strapi.db as unknown as {
    transaction(callback: unknown): Promise<unknown>;
    inTransaction(): boolean;
  };
  const original = db.transaction;
  let count = 0;
  let busy = false;
  db.transaction = async function (this: unknown, callback: unknown) {
    if (!busy && !db.inTransaction()) {
      count += 1;
      if (count === n) {
        busy = true;
        try {
          await between();
        } finally {
          busy = false;
        }
      }
    }
    return original.call(db, callback);
  };
  return () => {
    db.transaction = original;
  };
}

describe("due publishes (rules 4, 6, 9)", () => {
  it("publishes a due draft once, clears its schedule, advances the revision and audits it", async () => {
    const draft = await docs(ANNOUNCEMENT).create({ data: { title: "Due", publishAt: PAST } });
    const result = await run();
    expect(result.published).toEqual([`${ANNOUNCEMENT} ${draft.documentId}`]);
    const [draftRow, publishedRow] = await rows(ANNOUNCEMENT, draft.documentId);
    expect([
      draftRow.published,
      draftRow.publishAt,
      publishedRow.published,
      publishedRow.publishAt,
    ]).toEqual([false, null, true, null]);
    // The claim left the draft's updatedAt alone: the panel shows Published, not Modified.
    expect(new Date(String(draftRow.updatedAt)).getTime()).toBeLessThanOrEqual(
      new Date(String(publishedRow.updatedAt)).getTime(),
    );
    expect(await readRevision(strapi, ANNOUNCEMENT, draft.documentId)).toBe(2);
    expect(await audit(draft.documentId)).toEqual([
      ["create", "system", 1, null],
      ["schedulePublish", "cron", 2, null],
    ]);
    expect(await run()).toEqual(emptyResult());
  });

  it("leaves a future schedule alone", async () => {
    const draft = await docs(EVENT).create({ data: { title: "Later", publishAt: FUTURE } });
    expect((await run()).published).toEqual([]);
    expect((await rows(EVENT, draft.documentId))[0].publishAt).not.toBeNull();
  });

  it("orders by the due time, then the row id, at most SCHEDULE_BATCH per type and run", async () => {
    const created: string[] = [];
    for (let index = 0; index <= SCHEDULE_BATCH; index += 1) {
      const minute = String(index % 60).padStart(2, "0");
      const draft = await docs(EVENT).create({
        data: { title: `E${index}`, publishAt: `2026-11-02T07:${minute}:00.000Z` },
      });
      created.push(draft.documentId);
    }
    const first = await run();
    expect(first.published).toHaveLength(SCHEDULE_BATCH);
    const second = await run();
    expect(second.published).toHaveLength(1);
    expect(second.published[0]).toBe(`${EVENT} ${created[SCHEDULE_BATCH]}`);
  });

  it("a manual publish before the time clears the schedule: no republish later", async () => {
    const draft = await docs(EVENT).create({ data: { title: "Manual", publishAt: FUTURE } });
    await docs(EVENT).publish({ documentId: draft.documentId });
    const revision = await readRevision(strapi, EVENT, draft.documentId);
    expect((await run(new Date("2026-11-02T10:00:00.000Z"))).published).toEqual([]);
    expect(await readRevision(strapi, EVENT, draft.documentId)).toBe(revision);
  });
});

describe("schedule-clear and the audit keys", () => {
  it("the trail lists what the writer sent, not the schedule fields schedule-clear added", async () => {
    const draft = await docs(EVENT).create({ data: { title: "Keys" } });
    await docs(EVENT).update({
      documentId: draft.documentId,
      data: { title: "Keys", publishAt: FUTURE },
      status: "published",
    });
    const keys = (
      await open.db
        .query(AUDIT_EVENT_UID)
        .findMany({ where: { targetDocumentId: draft.documentId }, orderBy: { id: "asc" } })
    ).map((row) => [row.action, row.keys]);
    expect(keys).toEqual([
      ["create", ["title"]],
      // publishAt was sent (and written as null: publishing now wins), scheduleError was not.
      ["update", ["publishAt", "title"]],
      ["publish", null],
    ]);
  });
});

describe("the generation check (rules 4, 7)", () => {
  it("skips a document whose revision moved since the selection", async () => {
    const draft = await docs(ANNOUNCEMENT).create({ data: { title: "Due", publishAt: PAST } });
    const result = emptyResult();
    await runScheduledDocument(
      strapi,
      ANNOUNCEMENT,
      draft.documentId,
      "publish",
      NOW,
      new TransientAttempts(),
      result,
      0,
    );
    expect(result.skipped).toEqual([`${ANNOUNCEMENT} ${draft.documentId}`]);
    expect((await rows(ANNOUNCEMENT, draft.documentId)).map((row) => row.published)).toEqual([
      false,
    ]);
  });

  it("records nothing for a failure that a newer revision superseded (a stale failure)", async () => {
    const draft = await docs(ANNOUNCEMENT).create({ data: { publishAt: PAST } });
    const recorded = await recordScheduleFailure(
      strapi,
      ANNOUNCEMENT,
      draft.documentId,
      0,
      "publish",
      "invalid",
      "x",
    );
    expect(recorded).toBeNull();
    expect((await rows(ANNOUNCEMENT, draft.documentId))[0]).toMatchObject({
      publishAt: expect.anything(),
      scheduleError: null,
    });
  });
});

describe("failures (rule 7)", () => {
  it("a draft without its title ends in scheduleError notPublishable, unscheduled, audited", async () => {
    const draft = await docs(ANNOUNCEMENT).create({ data: { publishAt: PAST } });
    const result = await run();
    expect(result.failed).toEqual([`${ANNOUNCEMENT} ${draft.documentId}`]);
    expect(await rows(ANNOUNCEMENT, draft.documentId)).toEqual([
      expect.objectContaining({
        published: false,
        publishAt: null,
        scheduleError: "notPublishable",
      }),
    ]);
    expect(await readRevision(strapi, ANNOUNCEMENT, draft.documentId)).toBe(2);
    const trail = await audit(draft.documentId);
    expect(trail[1][0]).toBe("scheduleFailed");
    expect(String(trail[1][3])).toMatch(/^notPublishable: keys: title$/);
    expect(strapi.log.error).toHaveBeenCalledWith(
      `[scheduler] ${ANNOUNCEMENT} ${draft.documentId} failed: notPublishable`,
    );
    // The next save of the draft clears it.
    await docs(ANNOUNCEMENT).update({ documentId: draft.documentId, data: { title: "Fixed" } });
    expect((await rows(ANNOUNCEMENT, draft.documentId))[0].scheduleError).toBeNull();
  });

  it("transient failures keep the schedule; the fifth for one revision records retryExhausted", async () => {
    const draft = await docs(EVENT).create({ data: { title: "Busy", publishAt: PAST } });
    open.service.use(async (context, next) => {
      if (context.action === "publish")
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      return next();
    });
    const attempts = new TransientAttempts();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await run(NOW, attempts);
      expect(result.retrying, `attempt ${attempt}`).toEqual([`${EVENT} ${draft.documentId}`]);
      expect((await rows(EVENT, draft.documentId))[0].publishAt).not.toBeNull();
    }
    const fifth = await run(NOW, attempts);
    expect(fifth.failed).toEqual([`${EVENT} ${draft.documentId}`]);
    expect((await rows(EVENT, draft.documentId))[0]).toMatchObject({
      publishAt: null,
      scheduleError: "retryExhausted",
    });
  });
});

describe("withdrawals and pending updates (review findings)", () => {
  const failUnpublish = () =>
    open.service.use(async (context, next) => {
      if (context.action === "unpublish") {
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      }
      return next();
    });

  it("a due withdrawal that fails transiently is neither dropped nor published over", async () => {
    const link = await docs(QUICK_LINK).create({ data: { label: "Live" }, status: "published" });
    await docs(QUICK_LINK).update({
      documentId: link.documentId,
      data: { label: "Pending update", publishAt: PAST, unpublishAt: PAST },
    });
    failUnpublish();
    const attempts = new TransientAttempts();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await run(NOW, attempts);
      expect(result.retrying, `attempt ${attempt}`).toEqual([`${QUICK_LINK} ${link.documentId}`]);
      expect(result.published).toEqual([]);
      expect(result.expired).toEqual([]);
      const [draft, published] = await rows(QUICK_LINK, link.documentId);
      expect([draft.publishAt, draft.unpublishAt, published.published]).toEqual([
        expect.anything(),
        expect.anything(),
        true,
      ]);
    }
    // The fifth failure marks it (once) but keeps the withdrawal pending: the
    // deadline and the pending update stay, nothing is published over it.
    const fifth = await run(NOW, attempts);
    expect(fifth.failed).toEqual([`${QUICK_LINK} ${link.documentId}`]);
    expect(fifth.published).toEqual([]);
    const [draft] = await rows(QUICK_LINK, link.documentId);
    expect(draft).toMatchObject({ scheduleError: "retryExhausted" });
    expect(draft.unpublishAt).not.toBeNull();
    expect(draft.publishAt).not.toBeNull();
    const published = await open.db
      .query(QUICK_LINK)
      .findOne({ where: { documentId: link.documentId, publishedAt: { $notNull: true } } });
    expect(published?.label).toBe("Live");
  });

  it("five failures, then recovery: the withdrawal waits out its backoff and then succeeds", async () => {
    const link = await docs(QUICK_LINK).create({ data: { label: "Live" }, status: "published" });
    await docs(QUICK_LINK).update({ documentId: link.documentId, data: { unpublishAt: PAST } });
    const remove = failUnpublish();
    const attempts = new TransientAttempts();
    for (let attempt = 1; attempt <= 5; attempt += 1) await run(NOW, attempts);
    expect((await rows(QUICK_LINK, link.documentId))[0]).toMatchObject({
      scheduleError: "retryExhausted",
    });
    const markers = await audit(link.documentId);
    expect(markers.filter((row) => row[0] === "scheduleFailed")).toHaveLength(1);
    // Still failing after the first backoff (5 min): marked once, deferred again.
    const later = new Date(NOW.getTime() + 6 * 60_000);
    expect((await run(later, attempts)).failed).toEqual([`${QUICK_LINK} ${link.documentId}`]);
    expect(
      (await audit(link.documentId)).filter((row) => row[0] === "scheduleFailed"),
    ).toHaveLength(1);
    // The cause goes away; inside the second backoff (15 min) nothing is tried.
    remove();
    expect(await run(new Date(later.getTime() + 60_000), attempts)).toEqual(emptyResult());
    // After it, the withdrawal succeeds and the marker goes.
    const recovered = await run(new Date(later.getTime() + 16 * 60_000), attempts);
    expect(recovered.unpublished).toEqual([`${QUICK_LINK} ${link.documentId}`]);
    expect(await rows(QUICK_LINK, link.documentId)).toEqual([
      expect.objectContaining({ published: false, unpublishAt: null, scheduleError: null }),
    ]);
  });

  it("an author's save cuts a failed withdrawal's backoff short", async () => {
    const link = await docs(QUICK_LINK).create({ data: { label: "Live" }, status: "published" });
    await docs(QUICK_LINK).update({ documentId: link.documentId, data: { unpublishAt: PAST } });
    const remove = failUnpublish();
    const attempts = new TransientAttempts();
    for (let attempt = 1; attempt <= 5; attempt += 1) await run(NOW, attempts);
    remove();
    // A save of the draft (it keeps the deadline) moves the revision: tried at once.
    await docs(QUICK_LINK).update({ documentId: link.documentId, data: { label: "Live, saved" } });
    const result = await run(new Date(NOW.getTime() + 60_000), attempts);
    expect(result.unpublished).toEqual([`${QUICK_LINK} ${link.documentId}`]);
  });

  it("drafts that wait for their publish never starve the withdrawals behind them", async () => {
    for (let index = 0; index < SCHEDULE_BATCH + 10; index += 1) {
      await docs(QUICK_LINK).create({
        data: { label: `Waiting ${index}`, publishAt: FUTURE, unpublishAt: EARLIER },
      });
    }
    const link = await docs(QUICK_LINK).create({ data: { label: "Due" }, status: "published" });
    await docs(QUICK_LINK).update({ documentId: link.documentId, data: { unpublishAt: PAST } });
    const result = await run();
    expect(result.unpublished).toEqual([`${QUICK_LINK} ${link.documentId}`]);
  }, 60_000);

  it("published items whose withdrawals back off never starve an independent due publish", async () => {
    // Codex review: 50 published quick links with an earlier pending update
    // and a backed-off withdrawal filled every publish batch (each skipped
    // for the withdrawal's precedence), so a later due link never ran.
    const attempts = new TransientAttempts();
    for (let index = 0; index < SCHEDULE_BATCH; index += 1) {
      const link = await docs(QUICK_LINK).create({
        data: { label: `Live ${index}` },
        status: "published",
      });
      await docs(QUICK_LINK).update({
        documentId: link.documentId,
        data: { label: `Update ${index}`, publishAt: EARLIER, unpublishAt: EARLIER },
      });
      // Its withdrawal failed before and backs off: the unpublish pass waits.
      const revision = await readRevision(strapi, QUICK_LINK, link.documentId);
      attempts.deferWithdrawal(QUICK_LINK, link.documentId, NOW, revision);
    }
    const independent = await docs(QUICK_LINK).create({
      data: { label: "Independent", publishAt: PAST },
    });
    const result = await run(NOW, attempts);
    expect(result.published).toEqual([`${QUICK_LINK} ${independent.documentId}`]);
    expect([result.skipped, result.unpublished]).toEqual([[], []]);
  }, 120_000);

  it("a child page due with its parent waits for it: passed over, then published the next minute", async () => {
    const WIKI = "api::wiki-page.wiki-page";
    const parent = await docs(WIKI).create({ data: { title: "Parent", publishAt: PAST } });
    const child = await docs(WIKI).create({
      data: { title: "Child", parent: parent.documentId, publishAt: EARLIER },
    });
    const first = await run();
    expect(first.retrying).toEqual([]);
    expect(first.published).toEqual([`${WIKI} ${parent.documentId}`]);
    const second = await run();
    expect(second.published).toEqual([`${WIKI} ${child.documentId}`]);
  });
});

describe("dependencies (a course or parent page due itself)", () => {
  const WIKI = "api::wiki-page.wiki-page";

  it("more due children than a batch, scheduled before their parent, do not starve it", async () => {
    // Codex review of batch 15: the children filled every batch, the
    // parent never ran, and the fifth retry dropped every child's schedule.
    const parent = await docs(WIKI).create({ data: { title: "Parent", publishAt: PAST } });
    const children: string[] = [];
    for (let index = 0; index <= SCHEDULE_BATCH; index += 1) {
      const child = await docs(WIKI).create({
        data: { title: `Child ${index}`, parent: parent.documentId, publishAt: EARLIER },
      });
      children.push(child.documentId);
    }
    const attempts = new TransientAttempts();
    const first = await run(NOW, attempts);
    expect(first.published).toEqual([`${WIKI} ${parent.documentId}`]);
    expect([first.retrying, first.failed]).toEqual([[], []]);
    const second = await run(NOW, attempts);
    expect(second.published).toHaveLength(SCHEDULE_BATCH);
    const third = await run(NOW, attempts);
    expect(third.published).toHaveLength(1);
    for (const documentId of children) {
      const [draft, published] = await rows(WIKI, documentId);
      expect([draft.scheduleError, draft.publishAt, published?.published]).toEqual([
        null,
        null,
        true,
      ]);
    }
    expect(await run(NOW, attempts)).toEqual(emptyResult());
  }, 120_000);

  it("a refusal whose parent became due after the selection waits without a counted attempt", async () => {
    const parent = await docs(WIKI).create({ data: { title: "Parent", publishAt: PAST } });
    const child = await docs(WIKI).create({
      data: { title: "Child", parent: parent.documentId, publishAt: EARLIER },
    });
    const attempts = new TransientAttempts();
    const revision = await readRevision(strapi, WIKI, child.documentId);
    for (let attempt = 0; attempt <= SCHEDULE_TRANSIENT_ATTEMPTS; attempt += 1) {
      const result = emptyResult();
      await runScheduledDocument(
        strapi,
        WIKI,
        child.documentId,
        "publish",
        NOW,
        attempts,
        result,
        revision,
      );
      expect(result.retrying).toEqual([`${WIKI} ${child.documentId}`]);
    }
    expect(attempts.size).toBe(0);
    expect((await rows(WIKI, child.documentId))[0]).toMatchObject({
      publishAt: expect.anything(),
      scheduleError: null,
    });
    // The parent runs; then the child publishes.
    expect((await run(NOW, attempts)).published).toEqual([`${WIKI} ${parent.documentId}`]);
    expect((await run(NOW, attempts)).published).toEqual([`${WIKI} ${child.documentId}`]);
  });

  it("a parent behind more than 2,000 waiting children is still selected (no scan cap)", async () => {
    // Codex review of the fix: a selection that scanned at most 10 pages of
    // 200 rows skipped the same 2,000 waiting children every minute and
    // never reached their parent, nor any page after it.
    const parent = await docs(WIKI).create({ data: { title: "Parent", publishAt: PAST } });
    const WAITING = 2_001;
    for (let index = 0; index < WAITING; index += 1) {
      await docs(WIKI).create({
        data: { title: `Child ${index}`, parent: parent.documentId, publishAt: EARLIER },
      });
    }
    const independent = await docs(WIKI).create({ data: { title: "Other", publishAt: PAST } });
    const result = await run();
    expect(result.published).toEqual([
      `${WIKI} ${parent.documentId}`,
      `${WIKI} ${independent.documentId}`,
    ]);
    expect([result.retrying, result.failed]).toEqual([[], []]);
    // The next minute takes the first batch of the children, now eligible.
    expect((await run()).published).toHaveLength(SCHEDULE_BATCH);
  }, 600_000);

  it(`a parent cycle (A under B, B under A, both due) waits ${DEPENDENCY_WAIT_MINUTES} minutes, then ends in notPublishable`, async () => {
    // Codex review: the pages waited for each other forever. Now the wait is
    // bounded: after it they are selected, refused and recorded.
    const a = await docs(WIKI).create({ data: { title: "A", publishAt: PAST } });
    const b = await docs(WIKI).create({
      data: { title: "B", parent: a.documentId, publishAt: PAST },
    });
    await docs(WIKI).update({ documentId: a.documentId, data: { parent: b.documentId } });
    const child = await docs(WIKI).create({
      data: { title: "Under A", parent: a.documentId, publishAt: EARLIER },
    });
    const attempts = new TransientAttempts();
    // Within the wait: nothing is tried.
    expect(await run(NOW, attempts)).toEqual(emptyResult());
    const late = new Date(Date.parse(PAST) + (DEPENDENCY_WAIT_MINUTES + 1) * 60_000);
    const result = await run(late, attempts);
    expect([...result.failed].sort()).toEqual(
      [a, b, child].map((page) => `${WIKI} ${page.documentId}`).sort(),
    );
    expect(result.published).toEqual([]);
    for (const page of [a, b, child]) {
      expect((await rows(WIKI, page.documentId))[0]).toMatchObject({
        publishAt: null,
        scheduleError: "notPublishable",
      });
      const trail = await audit(page.documentId);
      expect(trail[trail.length - 1]).toEqual([
        "scheduleFailed",
        "cron",
        expect.any(Number),
        "notPublishable: keys: parent",
      ]);
    }
    expect(await run(late, attempts)).toEqual(emptyResult());
  });

  it("a readiness refusal is judged under the lock: a parent scheduled before the record makes it a wait", async () => {
    // TOCTOU review: the wait-or-fail decision was taken from a read before
    // the failure record's lock; a parent scheduled in between still cost
    // the child its schedule.
    const parent = await docs(WIKI).create({ data: { title: "Parent" } });
    const child = await docs(WIKI).create({
      data: { title: "Child", parent: parent.documentId, publishAt: EARLIER },
    });
    const attempts = new TransientAttempts();
    const result = emptyResult();
    const revision = await readRevision(strapi, WIKI, child.documentId);
    // 1st transaction: the publish (refused: the parent is not published);
    // before the 2nd, the failure record, an author schedules the parent.
    const undo = pauseBeforeTransaction(2, async () => {
      await docs(WIKI).update({ documentId: parent.documentId, data: { publishAt: PAST } });
    });
    try {
      await runScheduledDocument(
        strapi,
        WIKI,
        child.documentId,
        "publish",
        NOW,
        attempts,
        result,
        revision,
      );
    } finally {
      undo();
    }
    expect(result.retrying).toEqual([`${WIKI} ${child.documentId}`]);
    expect(result.failed).toEqual([]);
    expect(attempts.size).toBe(0);
    expect((await rows(WIKI, child.documentId))[0]).toMatchObject({
      publishAt: EARLIER,
      scheduleError: null,
    });
    expect((await run(NOW, attempts)).published).toEqual([`${WIKI} ${parent.documentId}`]);
    expect((await run(NOW, attempts)).published).toEqual([`${WIKI} ${child.documentId}`]);
  });

  it("a refusal whose parent was published before the record is not recorded: the next run publishes", async () => {
    // Codex review: the re-check asked only whether the parent was still
    // unpublished and due; a parent published in between passed it, and the
    // child lost its schedule to notPublishable.
    const parent = await docs(WIKI).create({ data: { title: "Parent" } });
    const child = await docs(WIKI).create({
      data: { title: "Child", parent: parent.documentId, publishAt: EARLIER },
    });
    const attempts = new TransientAttempts();
    const result = emptyResult();
    const revision = await readRevision(strapi, WIKI, child.documentId);
    // 1st transaction: the refused publish; before the 2nd (its record),
    // an author publishes the parent.
    const undo = pauseBeforeTransaction(2, async () => {
      await docs(WIKI).publish({ documentId: parent.documentId });
    });
    try {
      await runScheduledDocument(
        strapi,
        WIKI,
        child.documentId,
        "publish",
        NOW,
        attempts,
        result,
        revision,
      );
    } finally {
      undo();
    }
    expect(result.retrying).toEqual([`${WIKI} ${child.documentId}`]);
    expect(result.failed).toEqual([]);
    expect(attempts.size).toBe(0);
    expect((await rows(WIKI, child.documentId))[0]).toMatchObject({
      publishAt: EARLIER,
      scheduleError: null,
    });
    expect((await run(NOW, attempts)).published).toEqual([`${WIKI} ${child.documentId}`]);
  });

  it("a parent published between the two reads of the refusal's re-check is not recorded (Codex review)", async () => {
    // The blockers read the parent unpublished, the dependency read finds it
    // published (the child's lock does not serialise the parent's publish):
    // the refusal is stale, nothing is written, the next run publishes.
    const parent = await docs(WIKI).create({ data: { title: "Parent" } });
    const child = await docs(WIKI).create({
      data: { title: "Child", parent: parent.documentId, publishAt: EARLIER },
    });
    const attempts = new TransientAttempts();
    const result = emptyResult();
    const revision = await readRevision(strapi, WIKI, child.documentId);
    const undo = publishedBetweenReads(
      strapi.db as unknown as Parameters<typeof publishedBetweenReads>[0],
      WIKI,
      parent.documentId,
    );
    try {
      await runScheduledDocument(
        strapi,
        WIKI,
        child.documentId,
        "publish",
        NOW,
        attempts,
        result,
        revision,
      );
    } finally {
      undo();
    }
    expect(result.retrying).toEqual([`${WIKI} ${child.documentId}`]);
    expect(result.failed).toEqual([]);
    expect(attempts.size).toBe(0);
    expect((await rows(WIKI, child.documentId))[0]).toMatchObject({
      publishAt: EARLIER,
      scheduleError: null,
    });
  });

  it("a child whose parent is not due fails for good (notPublishable), as before", async () => {
    const parent = await docs(WIKI).create({ data: { title: "Parent", publishAt: FUTURE } });
    const child = await docs(WIKI).create({
      data: { title: "Child", parent: parent.documentId, publishAt: PAST },
    });
    const result = await run();
    expect(result.failed).toEqual([`${WIKI} ${child.documentId}`]);
    expect((await rows(WIKI, child.documentId))[0]).toMatchObject({
      publishAt: null,
      scheduleError: "notPublishable",
    });
  });
});

describe("the clock is sampled after each document's lock", () => {
  it("a delayed draft read crossing a quick link's deadline ends in windowExpired, no live row", async () => {
    const deadline = new Date(NOW.getTime() + 30_000).toISOString();
    const draft = await docs(QUICK_LINK).create({
      data: { label: "Short window", publishAt: PAST, unpublishAt: deadline },
    });
    // The run starts before the deadline; by the time the lock is held and
    // the draft read, the deadline has passed.
    const result = await runScheduledPublishing(
      strapi,
      NOW,
      new TransientAttempts(),
      () => new Date(NOW.getTime() + 60_000),
    );
    expect(result.expired).toEqual([`${QUICK_LINK} ${draft.documentId}`]);
    expect(result.published).toEqual([]);
    expect(await rows(QUICK_LINK, draft.documentId)).toEqual([
      expect.objectContaining({
        published: false,
        publishAt: null,
        scheduleError: "windowExpired",
      }),
    ]);
  });

  it("without the delay the same draft is published (the control)", async () => {
    const deadline = new Date(NOW.getTime() + 30_000).toISOString();
    const draft = await docs(QUICK_LINK).create({
      data: { label: "Short window", publishAt: PAST, unpublishAt: deadline },
    });
    const result = await runScheduledPublishing(strapi, NOW, new TransientAttempts(), () => NOW);
    expect(result.published).toEqual([`${QUICK_LINK} ${draft.documentId}`]);
  });
});

describe("the expired window (rule 5)", () => {
  it("an announcement whose publishAt and expiresAt both passed is not published", async () => {
    const draft = await docs(ANNOUNCEMENT).create({
      data: { title: "Too late", publishAt: EARLIER, expiresAt: PAST },
    });
    const result = await run();
    expect(result.expired).toEqual([`${ANNOUNCEMENT} ${draft.documentId}`]);
    expect(await rows(ANNOUNCEMENT, draft.documentId)).toEqual([
      expect.objectContaining({
        published: false,
        publishAt: null,
        scheduleError: "windowExpired",
      }),
    ]);
    expect((await audit(draft.documentId)).map((row) => [row[0], row[3]])).toEqual([
      ["create", null],
      ["scheduleFailed", "windowExpired"],
    ]);
  });

  it("a never-published quick link whose publishAt and unpublishAt both passed ends unscheduled", async () => {
    const draft = await docs(QUICK_LINK).create({
      data: { label: "Short window", publishAt: EARLIER, unpublishAt: PAST },
    });
    const result = await run();
    expect(result.expired).toEqual([`${QUICK_LINK} ${draft.documentId}`]);
    expect(await rows(QUICK_LINK, draft.documentId)).toEqual([
      expect.objectContaining({
        published: false,
        publishAt: null,
        unpublishAt: null,
        scheduleError: "windowExpired",
      }),
    ]);
  });
});

describe("due unpublishes (rules 4, 6)", () => {
  it("withdraws a published quick link on time and cancels its pending publish", async () => {
    const link = await docs(QUICK_LINK).create({
      data: { label: "Expiring" },
      status: "published",
    });
    await docs(QUICK_LINK).update({
      documentId: link.documentId,
      data: { unpublishAt: PAST, publishAt: FUTURE },
    });
    const result = await run();
    expect(result.unpublished).toEqual([`${QUICK_LINK} ${link.documentId}`]);
    expect(await rows(QUICK_LINK, link.documentId)).toEqual([
      expect.objectContaining({ published: false, publishAt: null, unpublishAt: null }),
    ]);
    expect((await audit(link.documentId)).map((row) => [row[0], row[1]]).slice(-1)).toEqual([
      ["scheduleUnpublish", "cron"],
    ]);
    // Later runs do not bring it back.
    expect((await run(new Date("2026-11-02T10:00:00.000Z"))).published).toEqual([]);
  });

  it("clears the withdrawal of a document that is not published (and audits it)", async () => {
    const draft = await docs(DOCUMENT).create({ data: { title: "Never live", unpublishAt: PAST } });
    const result = await run();
    expect(result.cleared).toEqual([`${DOCUMENT} ${draft.documentId}`]);
    expect((await rows(DOCUMENT, draft.documentId))[0].unpublishAt).toBeNull();
    expect((await audit(draft.documentId)).map((row) => row[0])).toEqual([
      "create",
      "scheduleUnpublish",
    ]);
  });
});

describe("issue #73: failing withdrawals never starve a healthy one (two tiers, a keyset cursor)", () => {
  /** Published quick links whose withdrawal failed for good before (`scheduleError` set). */
  async function seedFailing(prefix: string, count: number): Promise<string[]> {
    const documentIds: string[] = [];
    const data: Record<string, unknown>[] = [];
    for (let index = 0; index < count; index += 1) {
      const documentId = `${prefix}${String(index).padStart(24 - prefix.length, "0")}`;
      documentIds.push(documentId);
      data.push(
        { documentId, label: `${prefix} ${index}`, publishedAt: new Date(EARLIER) },
        {
          documentId,
          label: `${prefix} ${index}`,
          publishedAt: null,
          unpublishAt: new Date(EARLIER),
          scheduleError: "rejected",
        },
      );
    }
    const query = open.db.query(QUICK_LINK) as unknown as {
      createMany(params: { data: Record<string, unknown>[] }): Promise<unknown>;
    };
    for (let start = 0; start < data.length; start += 400) {
      await query.createMany({ data: data.slice(start, start + 400) });
    }
    return documentIds;
  }

  /** Every unpublish attempt by documentId; `refuse` fails for good, `stall` transiently. */
  function watchUnpublishes(refuse: ReadonlySet<string>, stall: ReadonlySet<string> = new Set()) {
    const attempted: string[] = [];
    open.service.use(async (context, next) => {
      const documentId = String((context.params as { documentId?: unknown })?.documentId);
      if (context.action === "unpublish") {
        attempted.push(documentId);
        if (refuse.has(documentId)) throw new errors.ApplicationError("refused");
        if (stall.has(documentId)) {
          throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        }
      }
      return next();
    });
    return attempted;
  }

  const live = async (documentId: string) =>
    (await rows(QUICK_LINK, documentId)).some((row) => row.published);

  it("2,001 failing earlier withdrawals: a healthy later one is withdrawn in the first run", async () => {
    const failing = await seedFailing("fail", 2_001);
    const attempted = watchUnpublishes(new Set(failing));
    const healthy = await docs(QUICK_LINK).create({
      data: { label: "Healthy" },
      status: "published",
    });
    await docs(QUICK_LINK).update({ documentId: healthy.documentId, data: { unpublishAt: PAST } });
    const result = await run(NOW, new TransientAttempts());
    expect(result.unpublished).toEqual([`${QUICK_LINK} ${healthy.documentId}`]);
    expect(await live(healthy.documentId)).toBe(false);
    // The reserved quota still tried the oldest failures, in id order.
    expect(result.failed).toHaveLength(WITHDRAWAL_RETRY_QUOTA);
    expect(attempted.filter((id) => id !== healthy.documentId)).toEqual(
      failing.slice(0, WITHDRAWAL_RETRY_QUOTA),
    );
  }, 120_000);

  it("with tier 1 full, every ready failure is attempted within ⌈N/10⌉ runs, in cursor order, none skipped", async () => {
    const failing = await seedFailing("ffff", 25);
    const attempts = new TransientAttempts();
    // Three failures still back off: examined, passed over, never attempted.
    const waiting = new Set([failing[3], failing[12], failing[20]]);
    for (const documentId of waiting) {
      attempts.deferWithdrawal(
        QUICK_LINK,
        documentId,
        NOW,
        await readRevision(strapi, QUICK_LINK, documentId),
      );
    }
    // 60 healthy due withdrawals that fail transiently keep tier 1 full.
    const stalled = new Set<string>();
    for (let index = 0; index < 60; index += 1) {
      const link = await docs(QUICK_LINK).create({
        data: { label: `Stalled ${index}` },
        status: "published",
      });
      await docs(QUICK_LINK).update({ documentId: link.documentId, data: { unpublishAt: PAST } });
      stalled.add(link.documentId);
    }
    const attempted = watchUnpublishes(new Set(failing), stalled);
    const ready = failing.filter((id) => !waiting.has(id));
    const runs = Math.ceil(ready.length / WITHDRAWAL_RETRY_QUOTA);
    expect(runs).toBe(3);
    const perRun: string[][] = [];
    for (let n = 0; n < runs; n += 1) {
      const before = attempted.length;
      const result = await run(NOW, attempts);
      // Tier 1 takes every slot the retry tier leaves.
      expect(result.retrying.length + result.failed.length).toBe(SCHEDULE_BATCH);
      perRun.push(attempted.slice(before).filter((id) => !stalled.has(id)));
    }
    expect(perRun).toEqual([ready.slice(0, 10), ready.slice(10, 20), ready.slice(20)]);
    expect(attempted.filter((id) => waiting.has(id))).toEqual([]);
  }, 180_000);

  it("the cursor wraps at the end, never past where the run began, and starts over after a full circle", async () => {
    const failing = await seedFailing("wrap", 15);
    const attempted = watchUnpublishes(new Set(failing));
    const attempts = new TransientAttempts();
    expect((await run(NOW, attempts)).failed).toHaveLength(10);
    // The last five, then the wrap finds only rows that back off now.
    expect((await run(NOW, attempts)).failed).toHaveLength(5);
    expect(attempted).toEqual(failing);
    expect((await run(NOW, attempts)).failed).toEqual([]);
    // After the first backoff (5 minutes) the circle starts again at the beginning.
    const later = new Date(NOW.getTime() + 6 * 60_000);
    expect((await run(later, attempts)).failed).toEqual(
      failing.slice(0, 10).map((id) => `${QUICK_LINK} ${id}`),
    );
  }, 120_000);

  it(`examines at most ${WITHDRAWAL_RETRY_SCAN} rows per run and goes on from there the next run`, async () => {
    const failing = await seedFailing("scan", WITHDRAWAL_RETRY_SCAN + 50);
    const attempts = new TransientAttempts();
    const last = failing[failing.length - 1];
    for (const documentId of failing.slice(0, -1)) {
      attempts.deferWithdrawal(QUICK_LINK, documentId, NOW, 0);
    }
    const attempted = watchUnpublishes(new Set(failing));
    await run(NOW, attempts);
    expect(attempted).toEqual([]);
    await run(NOW, attempts);
    expect(attempted).toEqual([last]);
  }, 120_000);
});
