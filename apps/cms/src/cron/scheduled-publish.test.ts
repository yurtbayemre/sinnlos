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
  TransientAttempts,
  createScheduleClear,
  type ScheduleClearHost,
} from "../utils/schedule";
import {
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
    minimalType("api::wiki-page.wiki-page", "wiki_pages", { ...title, ...schedule }),
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
    expect(recorded).toBe(false);
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
    expect(String(trail[1][3])).toMatch(
      /^notPublishable: This draft cannot be published yet: title$/,
    );
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
