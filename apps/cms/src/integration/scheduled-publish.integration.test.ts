import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ADMIN_ENV,
  adminRequest,
  contentManager,
  type ContentManager,
} from "./admin-api.test.helper";
import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";

/**
 * Scheduled publishing on Strapi CE (decision 06 §D; batch 15 item 5;
 * spike 9 S9.0-S9.7 on the real cms): the scheduled-publisher task with
 * the document layer's middlewares, the lifecycles and the after-commit
 * fan-out. Schedules are set in-process (Document Service) and through the
 * admin panel; the allowlist's checks (publishAt in the future, unpublishAt
 * after publishAt) are lane 15A's.
 */

const ANNOUNCEMENT = "api::announcement.announcement";
const QUICK_LINK = "api::quick-link.quick-link";
const COURSE = "api::course.course";
const LESSON = "api::lesson.lesson";
const WIKI_PAGE = "api::wiki-page.wiki-page";
/** SCHEDULE_BATCH of utils/schedule.ts: due drafts per type and run. */
const SCHEDULE_BATCH = 50;
const NOTIFICATION = "api::notification.notification";

interface RunResult {
  published: string[];
  unpublished: string[];
  cleared: string[];
  expired: string[];
  failed: string[];
  retrying: string[];
  skipped: string[];
}

interface Scheduler {
  runScheduledPublishing(
    strapi: unknown,
    now?: Date,
    attempts?: unknown,
    clock?: () => Date,
  ): Promise<RunResult>;
  runScheduledDocument(
    strapi: unknown,
    uid: string,
    documentId: string,
    pass: "publish" | "unpublish",
    time: Date | (() => Date),
    attempts: unknown,
    result: RunResult,
    r: number,
  ): Promise<void>;
  emptyResult(): RunResult;
}

interface Schedule {
  TransientAttempts: new () => unknown;
}

interface TimeModule {
  wallTimeToInstant(date: unknown, time: string, zone: string, disambiguation: string): Date;
  parsePlainDate(value: string): unknown;
}

interface CronTask {
  task: (context: { strapi: unknown }) => Promise<void>;
  options: { rule: string; tz: string };
}

describe.each(testEngines())("scheduled publishing on %s", (engine) => {
  let t: TestStrapi;
  let panel: ContentManager;
  let scheduler: Scheduler;

  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: ADMIN_ENV });
    panel = await contentManager(t);
    scheduler = t.requireBuilt<Scheduler>("src/cron/scheduled-publish");
  });

  afterAll(async () => {
    await t?.stop();
  });

  const run = (now?: Date) => scheduler.runScheduledPublishing(t.strapi, now);
  const cronTask = () =>
    (t.strapi.config.get("server.cron.tasks") as Record<string, CronTask>)["scheduled-publisher"];
  const ago = (ms = 1_000) => new Date(Date.now() - ms).toISOString();
  const ahead = (ms = 3_600_000) => new Date(Date.now() + ms).toISOString();
  const key = (uid: string, documentId: string) => `${uid} ${documentId}`;

  const settleFanouts = () =>
    t
      .requireBuilt<{ __fanoutsSettledForTest(): Promise<void> }>("src/utils/notify")
      .__fanoutsSettledForTest();
  const notified = async (documentId: string) => {
    await settleFanouts();
    const rows = await t.strapi.db.query(NOTIFICATION).findMany({
      where: { sourceDocumentId: documentId },
      populate: { recipient: { select: ["id"] } },
    });
    return rows
      .map((row) => (row.recipient as { id: number } | null)?.id ?? -1)
      .sort((a, b) => a - b);
  };
  const memberSees = async (documentId: string) =>
    (await t.api("member", `/api/announcements/${documentId}`)).status === 200;
  const rows = async (uid: string, documentId: string) =>
    (await t.strapi.db
      .query(uid)
      .findMany({ where: { documentId }, orderBy: { id: "asc" } })) as Row[];
  const draftOf = async (uid: string, documentId: string) =>
    (await rows(uid, documentId)).find((row) => row.publishedAt == null);
  const scheduledAnnouncement = async (title: string, data: Record<string, unknown> = {}) =>
    (
      await t.strapi.documents(ANNOUNCEMENT).create({
        data: { title, audience: "all", ...data },
      })
    ).documentId;

  it("S9.0 CE: Releases are not loaded; the task runs every minute in APP_TIME_ZONE; the columns and indexes exist", async () => {
    const releases = await adminRequest(t, panel.token, "/content-releases/");
    expect(releases.status).toBe(404);
    expect(cronTask().options).toEqual({ rule: "* * * * *", tz: "Europe/Berlin" });
    if (engine === "postgres") {
      const columns = await t.database.sql<{
        table_name: string;
        column_name: string;
        data_type: string;
      }>(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND column_name IN ('publish_at', 'unpublish_at')
          ORDER BY table_name, column_name`,
      );
      expect(columns.map((c) => `${c.table_name}.${c.column_name} ${c.data_type}`)).toEqual([
        "announcements.publish_at timestamp with time zone",
        "courses.publish_at timestamp with time zone",
        "documents.publish_at timestamp with time zone",
        "documents.unpublish_at timestamp with time zone",
        "events.publish_at timestamp with time zone",
        "lessons.publish_at timestamp with time zone",
        "quick_links.publish_at timestamp with time zone",
        "quick_links.unpublish_at timestamp with time zone",
        "wiki_pages.publish_at timestamp with time zone",
      ]);
      const indexes = await t.database.sql<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = current_schema() AND (indexname LIKE '%_partial_idx' OR indexname = 'content_versions_target_uq')
          ORDER BY indexname`,
      );
      expect(indexes.map((index) => index.indexname)).toEqual([
        "announcements_publish_at_partial_idx",
        "content_versions_target_uq",
        "courses_publish_at_partial_idx",
        "documents_publish_at_partial_idx",
        "documents_unpublish_at_partial_idx",
        "events_publish_at_partial_idx",
        "lessons_publish_at_partial_idx",
        "quick_links_publish_at_partial_idx",
        "quick_links_unpublish_at_partial_idx",
        "wiki_pages_publish_at_partial_idx",
      ]);
      expect(
        indexes.find((index) => index.indexname === "content_versions_target_uq")?.indexdef,
      ).toMatch(/^CREATE UNIQUE INDEX .* \(target_uid, target_document_id\)$/);
      expect(
        indexes.find((index) => index.indexname === "documents_unpublish_at_partial_idx")?.indexdef,
      ).toMatch(/WHERE \(unpublish_at IS NOT NULL\)$/);
    }
  });

  it("S9.1 the cron task publishes a due draft; its audience is notified once, after the commit", async () => {
    const documentId = await scheduledAnnouncement("Scheduled 1", { publishAt: ago() });
    expect(await memberSees(documentId)).toBe(false);
    await cronTask().task({ strapi: t.strapi });
    expect(await memberSees(documentId)).toBe(true);
    const first = await notified(documentId);
    expect(first.length).toBeGreaterThan(0);
    expect(first).toContain(t.fixtures.users.member.id);
    expect(new Set(first).size).toBe(first.length);
    expect((await rows(ANNOUNCEMENT, documentId)).map((row) => row.publishAt)).toEqual([
      null,
      null,
    ]);
    expect((await run()).published).not.toContain(key(ANNOUNCEMENT, documentId));
    expect(await notified(documentId)).toEqual(first);
  });

  it("S9.2 three runners at once (separate connections) publish a due draft once, and notify once", async () => {
    const documentId = await scheduledAnnouncement("Scheduled 2", { publishAt: ago() });
    const results = await Promise.all([run(), run(), run()]);
    expect(
      results.filter((result) => result.published.includes(key(ANNOUNCEMENT, documentId))),
    ).toHaveLength(1);
    expect(
      (await rows(ANNOUNCEMENT, documentId)).filter((row) => row.publishedAt != null),
    ).toHaveLength(1);
    const recipients = await notified(documentId);
    expect(new Set(recipients).size).toBe(recipients.length);
    // The in-process guard: an overlapping cron invoke is skipped.
    await Promise.all([
      cronTask().task({ strapi: t.strapi }),
      cronTask().task({ strapi: t.strapi }),
    ]);
  });

  it("S9.3 a future schedule waits; a manual publish before it clears it (no republish later)", async () => {
    const documentId = await scheduledAnnouncement("Scheduled 3", { publishAt: ahead() });
    expect((await run()).published).not.toContain(key(ANNOUNCEMENT, documentId));
    await t.strapi.documents(ANNOUNCEMENT).publish({ documentId });
    const published = (await rows(ANNOUNCEMENT, documentId)).find((row) => row.publishedAt != null);
    expect((await run(new Date(Date.now() + 2 * 3_600_000))).published).not.toContain(
      key(ANNOUNCEMENT, documentId),
    );
    const still = (await rows(ANNOUNCEMENT, documentId)).find((row) => row.publishedAt != null);
    expect(still?.id).toBe(published?.id);
  });

  it("S9.4 the admin panel schedules too; after the run it shows Published, not Modified", async () => {
    const created = await panel.create(ANNOUNCEMENT, {
      title: "Panel scheduled",
      audience: "all",
      publishAt: ago(),
    });
    expect(created.status, created.text).toBe(201);
    const documentId = created.body.data.documentId;
    expect((await run()).published).toContain(key(ANNOUNCEMENT, documentId));
    const [draft, published] = await rows(ANNOUNCEMENT, documentId);
    expect(new Date(String(draft.updatedAt)).getTime()).toBeLessThanOrEqual(
      new Date(String(published.updatedAt)).getTime(),
    );
    const view = await panel.findOne(ANNOUNCEMENT, documentId);
    expect(view.status).toBe(200);
    expect(view.body.data.publishAt).toBeNull();
  });

  it("S9.5 unpublishAt withdraws a published quick link on time and clears itself", async () => {
    const link = await t.strapi.documents(QUICK_LINK).create({
      data: { label: "Expiring", url: "https://example.org/expiring" },
      status: "published",
    });
    await t.strapi.documents(QUICK_LINK).update({
      documentId: link.documentId,
      data: { unpublishAt: ahead(1_000) },
    });
    const result = await run(new Date(Date.now() + 5_000));
    expect(result.unpublished).toContain(key(QUICK_LINK, link.documentId));
    expect(
      (await rows(QUICK_LINK, link.documentId)).map((row) => [row.publishedAt, row.unpublishAt]),
    ).toEqual([[null, null]]);
  });

  it("S9.6 an offset-less schedule is refused (DT-OFFSETLESS), in the panel too", async () => {
    const offsetless = await panel.create(ANNOUNCEMENT, {
      title: "x",
      publishAt: "2026-10-25T02:30",
    });
    expect(offsetless.status).toBe(400);
    expect(offsetless.body.error?.details).toMatchObject({ keys: ["publishAt"] });
  });

  it("S9.7 the cms reads wall times in reject mode: the repeated and the skipped DST hour are refused", () => {
    const time = t.requireBuilt<TimeModule>("src/utils/time");
    for (const day of ["2026-10-25", "2027-03-28"]) {
      expect(() =>
        time.wallTimeToInstant(time.parsePlainDate(day), "02:30", "Europe/Berlin", "reject"),
      ).toThrow(RangeError);
    }
    expect(
      time
        .wallTimeToInstant(time.parsePlainDate("2026-10-26"), "09:00", "Europe/Berlin", "reject")
        .toISOString(),
    ).toBe("2026-10-26T08:00:00.000Z");
  });

  it("a scheduled draft without a title ends in scheduleError notPublishable, unscheduled", async () => {
    const created = await panel.create(ANNOUNCEMENT, { audience: "all", publishAt: ago() });
    expect(created.status, created.text).toBe(201);
    const documentId = created.body.data.documentId;
    expect((await run()).failed).toContain(key(ANNOUNCEMENT, documentId));
    expect(await draftOf(ANNOUNCEMENT, documentId)).toMatchObject({
      publishAt: null,
      scheduleError: "notPublishable",
    });
    expect(await rows(ANNOUNCEMENT, documentId)).toHaveLength(1);
    // The next save of the draft clears it.
    await panel.update(ANNOUNCEMENT, documentId, { title: "Now with a title" });
    expect((await draftOf(ANNOUNCEMENT, documentId))?.scheduleError).toBeNull();
  });

  it("readiness at execution: a lesson whose course was unpublished after scheduling is not published", async () => {
    const course = await t.strapi.documents(COURSE).create({
      data: { title: "Scheduled course", slug: "it-scheduled-course" },
      status: "published",
    });
    const lesson = await t.strapi.documents(LESSON).create({
      data: { title: "Scheduled lesson", course: course.documentId, publishAt: ahead(1_000) },
    });
    await t.strapi.documents(COURSE).unpublish({ documentId: course.documentId });
    const result = await run(new Date(Date.now() + 5_000));
    expect(result.failed).toContain(key(LESSON, lesson.documentId));
    expect(await draftOf(LESSON, lesson.documentId)).toMatchObject({
      publishAt: null,
      scheduleError: "notPublishable",
    });
    expect(
      (await rows(LESSON, lesson.documentId)).filter((row) => row.publishedAt != null),
    ).toEqual([]);
  });

  it("more due child pages than a batch, scheduled before their parent, do not starve it (Codex review)", async () => {
    // Before: the children filled every batch, readiness refused each (the
    // parent unpublished), the parent never ran, and the fifth retry cleared
    // every child's schedule (retryExhausted).
    const base = Date.now();
    const slug = (name: string) => `it-sched-${name}-${base}`;
    const parent = await t.strapi.documents(WIKI_PAGE).create({
      data: { title: "Scheduled parent", slug: slug("parent"), publishAt: ago(1_000) },
    });
    const children: string[] = [];
    for (let index = 0; index <= SCHEDULE_BATCH; index += 1) {
      const child = await t.strapi.documents(WIKI_PAGE).create({
        data: {
          title: `Scheduled child ${index}`,
          slug: slug(`child-${index}`),
          parent: parent.documentId,
          publishAt: ago(120_000),
        },
      });
      children.push(child.documentId);
    }
    const attempts = new (t.requireBuilt<Schedule>("src/utils/schedule").TransientAttempts)();
    const now = new Date();
    const first = await scheduler.runScheduledPublishing(t.strapi, now, attempts);
    expect(first.published).toContain(key(WIKI_PAGE, parent.documentId));
    expect(first.retrying).toEqual([]);
    expect(first.failed).toEqual([]);
    for (let minute = 0; minute < 3; minute += 1) {
      await scheduler.runScheduledPublishing(t.strapi, now, attempts);
    }
    for (const documentId of children) {
      const all = await rows(WIKI_PAGE, documentId);
      expect(
        all.filter((row) => row.publishedAt != null),
        documentId,
      ).toHaveLength(1);
      expect(await draftOf(WIKI_PAGE, documentId)).toMatchObject({
        publishAt: null,
        scheduleError: null,
      });
    }
  }, 300_000);

  /** Runs `between` before the n-th transaction opened outside any other; returns the undo. */
  const pauseBeforeTransaction = (n: number, between: () => Promise<void>) => {
    const db = t.strapi.db as unknown as {
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
  };
  const revisionOf = (uid: string, documentId: string) =>
    t
      .requireBuilt<{
        readRevision(strapi: unknown, uid: string, documentId: string): Promise<number>;
      }>("src/utils/document-lock")
      .readRevision(t.strapi, uid, documentId);
  const newAttempts = () =>
    new (t.requireBuilt<Schedule>("src/utils/schedule").TransientAttempts)() as {
      size: number;
      deferWithdrawal(uid: string, documentId: string, now: Date, revision: number): Date;
    };

  it("a parent cycle among scheduled wiki pages waits out the dependency limit, then ends in notPublishable (Codex review)", async () => {
    // The admin panel and the Document Service let a draft's parent point
    // back at its own child; both pages waited for each other forever. The
    // wait is bounded now (DEPENDENCY_WAIT_MINUTES, 60). Since batch 16 the
    // wiki checks refuse a write that closes the loop (parentCycle, for
    // every writer), so the loop here is one left from before (an older
    // panel, raw SQL): its link row is written raw.
    const base = Date.now();
    const slug = (name: string) => `it-cycle-${name}-${base}`;
    const due = new Date(base - 60_000).toISOString();
    const a = await t.strapi.documents(WIKI_PAGE).create({
      data: { title: "Cycle A", slug: slug("a"), publishAt: due },
    });
    const b = await t.strapi.documents(WIKI_PAGE).create({
      data: { title: "Cycle B", slug: slug("b"), parent: a.documentId, publishAt: due },
    });
    await expect(
      t.strapi
        .documents(WIKI_PAGE)
        .update({ documentId: a.documentId, data: { parent: b.documentId } }),
    ).rejects.toThrow(/below itself/);
    const join = (
      (t.strapi.db as unknown as { metadata: { get(uid: string): unknown } }).metadata.get(
        WIKI_PAGE,
      ) as {
        attributes: Record<
          string,
          {
            joinTable: {
              name: string;
              joinColumn: { name: string };
              inverseJoinColumn: { name: string };
            };
          }
        >;
      }
    ).attributes.parent.joinTable;
    await (
      t.strapi.db as unknown as {
        getConnection(table: string): { insert(row: Record<string, unknown>): Promise<unknown> };
      }
    )
      .getConnection(join.name)
      .insert({
        [join.joinColumn.name]: (await draftOf(WIKI_PAGE, a.documentId))?.id,
        [join.inverseJoinColumn.name]: (await draftOf(WIKI_PAGE, b.documentId))?.id,
      });
    const attempts = newAttempts();
    const within = await scheduler.runScheduledPublishing(t.strapi, new Date(base), attempts);
    for (const page of [a, b]) {
      expect(within.failed).not.toContain(key(WIKI_PAGE, page.documentId));
      expect(within.published).not.toContain(key(WIKI_PAGE, page.documentId));
    }
    const late = new Date(base + 61 * 60_000);
    const result = await scheduler.runScheduledPublishing(t.strapi, late, attempts);
    expect(result.failed).toEqual(
      expect.arrayContaining([key(WIKI_PAGE, a.documentId), key(WIKI_PAGE, b.documentId)]),
    );
    for (const page of [a, b]) {
      expect(await draftOf(WIKI_PAGE, page.documentId)).toMatchObject({
        publishAt: null,
        scheduleError: "notPublishable",
      });
      const failures = await t.strapi.db.query("api::audit-event.audit-event").findMany({
        where: { targetDocumentId: page.documentId, action: "scheduleFailed" },
        select: ["source", "detail"],
      });
      expect(failures).toEqual([
        expect.objectContaining({ source: "cron", detail: "notPublishable: keys: parent" }),
      ]);
      expect(
        (await rows(WIKI_PAGE, page.documentId)).filter((row) => row.publishedAt != null),
      ).toEqual([]);
    }
  });

  it("a refusal whose parent was published before its record is not recorded; the next run publishes (Codex review)", async () => {
    const base = Date.now();
    const slug = (name: string) => `it-refusal-${name}-${base}`;
    const parent = await t.strapi.documents(WIKI_PAGE).create({
      data: { title: "Late parent", slug: slug("parent") },
    });
    const child = await t.strapi.documents(WIKI_PAGE).create({
      data: {
        title: "Early child",
        slug: slug("child"),
        parent: parent.documentId,
        publishAt: ago(60_000),
      },
    });
    await settleFanouts();
    const attempts = newAttempts();
    const result = scheduler.emptyResult();
    const revision = await revisionOf(WIKI_PAGE, child.documentId);
    // The 1st transaction is the refused publish (the parent is not
    // published); before the 2nd, its record, an author publishes the parent.
    const undo = pauseBeforeTransaction(2, async () => {
      await t.strapi.documents(WIKI_PAGE).publish({ documentId: parent.documentId });
    });
    try {
      await scheduler.runScheduledDocument(
        t.strapi,
        WIKI_PAGE,
        child.documentId,
        "publish",
        new Date(),
        attempts,
        result,
        revision,
      );
    } finally {
      undo();
    }
    expect(result.retrying).toEqual([key(WIKI_PAGE, child.documentId)]);
    expect(result.failed).toEqual([]);
    expect(attempts.size).toBe(0);
    expect(await draftOf(WIKI_PAGE, child.documentId)).toMatchObject({ scheduleError: null });
    expect((await draftOf(WIKI_PAGE, child.documentId))?.publishAt).not.toBeNull();
    const next = await scheduler.runScheduledPublishing(t.strapi, new Date(), attempts);
    expect(next.published).toContain(key(WIKI_PAGE, child.documentId));
  });

  it("a parent published between the two reads of the refusal's re-check is not recorded (Codex review)", async () => {
    // Controlled reads inside the failure record (the 2nd outer
    // transaction): the first "published" count of the parent answers the
    // database (0), every later one 1. On Postgres the child's lock does
    // not serialise the parent's publish, so the re-check can see both.
    const base = Date.now();
    const slug = (name: string) => `it-two-reads-${name}-${base}`;
    const parent = await t.strapi.documents(WIKI_PAGE).create({
      data: { title: "Two reads parent", slug: slug("parent") },
    });
    const child = await t.strapi.documents(WIKI_PAGE).create({
      data: {
        title: "Two reads child",
        slug: slug("child"),
        parent: parent.documentId,
        publishAt: ago(60_000),
      },
    });
    await settleFanouts();
    const db = t.strapi.db as unknown as {
      query(uid: string): unknown;
      transaction(callback: unknown): Promise<unknown>;
      inTransaction(): boolean;
    };
    const originalQuery = db.query;
    const originalTransaction = db.transaction;
    let outer = 0;
    let inRecord = false;
    let reads = 0;
    db.transaction = async function (this: unknown, callback: unknown) {
      if (!db.inTransaction()) {
        outer += 1;
        inRecord = outer === 2;
      }
      return originalTransaction.call(db, callback);
    };
    db.query = function (this: unknown, name: string) {
      const query = originalQuery.call(db, name) as Record<string, unknown>;
      if (name !== WIKI_PAGE) return query;
      return new Proxy(query, {
        get(target, prop) {
          const value = target[prop as string];
          if (prop !== "count" || typeof value !== "function") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (params: { where?: Record<string, unknown> }) => {
            const where = params?.where ?? {};
            const published =
              where.documentId === parent.documentId &&
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
    const attempts = newAttempts();
    const result = scheduler.emptyResult();
    try {
      await scheduler.runScheduledDocument(
        t.strapi,
        WIKI_PAGE,
        child.documentId,
        "publish",
        new Date(),
        attempts,
        result,
        await revisionOf(WIKI_PAGE, child.documentId),
      );
    } finally {
      db.query = originalQuery;
      db.transaction = originalTransaction;
    }
    expect(reads).toBeGreaterThan(1);
    expect(result.retrying).toEqual([key(WIKI_PAGE, child.documentId)]);
    expect(result.failed).toEqual([]);
    expect(attempts.size).toBe(0);
    expect(await draftOf(WIKI_PAGE, child.documentId)).toMatchObject({ scheduleError: null });
    expect((await draftOf(WIKI_PAGE, child.documentId))?.publishAt).not.toBeNull();
  });

  it("published quick links whose withdrawals back off never starve an independent due quick link (Codex review)", async () => {
    // 50 published links with an earlier pending update and a backed-off
    // withdrawal filled every publish batch (each skipped for the
    // withdrawal's precedence); the selection now leaves them out.
    const attempts = newAttempts();
    const now = new Date();
    const earlier = new Date(now.getTime() - 10 * 60_000).toISOString();
    const backedOff = new Set<string>();
    for (let index = 0; index < SCHEDULE_BATCH; index += 1) {
      const link = await t.strapi.documents(QUICK_LINK).create({
        data: { label: `Backed off ${index}`, url: `https://example.org/backed-off-${index}` },
        status: "published",
      });
      await t.strapi.documents(QUICK_LINK).update({
        documentId: link.documentId,
        data: { label: `Update ${index}`, publishAt: earlier, unpublishAt: earlier },
      });
      attempts.deferWithdrawal(
        QUICK_LINK,
        link.documentId,
        now,
        await revisionOf(QUICK_LINK, link.documentId),
      );
      backedOff.add(key(QUICK_LINK, link.documentId));
    }
    const independent = await t.strapi.documents(QUICK_LINK).create({
      data: {
        label: "Independent",
        url: "https://example.org/independent",
        // Due at the run's time, taken before the 100 writes above.
        publishAt: new Date(now.getTime() - 1_000).toISOString(),
      },
    });
    const result = await scheduler.runScheduledPublishing(t.strapi, now, attempts);
    expect(result.published).toContain(key(QUICK_LINK, independent.documentId));
    expect([...result.skipped, ...result.published].filter((k) => backedOff.has(k))).toEqual([]);
  }, 300_000);

  it("the expired window: publishAt and expiresAt both passed during a stop: nothing published, nobody notified", async () => {
    const documentId = await scheduledAnnouncement("Expired while down", {
      publishAt: ago(120_000),
      expiresAt: ago(60_000),
    });
    expect((await run()).expired).toContain(key(ANNOUNCEMENT, documentId));
    expect(await draftOf(ANNOUNCEMENT, documentId)).toMatchObject({
      publishAt: null,
      scheduleError: "windowExpired",
    });
    expect(await memberSees(documentId)).toBe(false);
    expect(await notified(documentId)).toEqual([]);
  });

  it("the expired window: a never-published quick link whose publishAt and unpublishAt passed before one run", async () => {
    const link = await t.strapi.documents(QUICK_LINK).create({
      data: {
        label: "Missed",
        url: "https://example.org/missed",
        publishAt: ago(120_000),
        unpublishAt: ago(60_000),
      },
    });
    const result = await run();
    expect(result.expired).toContain(key(QUICK_LINK, link.documentId));
    expect(await rows(QUICK_LINK, link.documentId)).toEqual([
      expect.objectContaining({
        publishedAt: null,
        publishAt: null,
        unpublishAt: null,
        scheduleError: "windowExpired",
      }),
    ]);
  });

  it("an unpublish (panel) and a discard (panel) cancel a pending publish", async () => {
    for (const cancel of ["unpublish", "discard"] as const) {
      const live = await t.strapi.documents(ANNOUNCEMENT).create({
        data: { title: `Live ${cancel}`, audience: "all" },
        status: "published",
      });
      await t.strapi.documents(ANNOUNCEMENT).update({
        documentId: live.documentId,
        data: { title: `Scheduled update ${cancel}`, publishAt: ahead(1_000) },
      });
      const answer =
        cancel === "unpublish"
          ? await panel.unpublish(ANNOUNCEMENT, live.documentId)
          : await panel.discard(ANNOUNCEMENT, live.documentId);
      expect(answer.status, answer.text).toBe(200);
      expect((await draftOf(ANNOUNCEMENT, live.documentId))?.publishAt, cancel).toBeNull();
      const result = await run(new Date(Date.now() + 5_000));
      expect(result.published, cancel).not.toContain(key(ANNOUNCEMENT, live.documentId));
    }
  });

  it("a panel clone starts unscheduled", async () => {
    const created = await panel.create(QUICK_LINK, {
      label: "To clone",
      url: "https://example.org/clone",
      publishAt: ahead(),
      unpublishAt: ahead(7_200_000),
    });
    const cloned = await panel.clone(QUICK_LINK, created.body.data.documentId, { label: "Clone" });
    expect(cloned.status, cloned.text).toBe(200);
    expect(await draftOf(QUICK_LINK, cloned.body.data.documentId)).toMatchObject({
      publishAt: null,
      unpublishAt: null,
      scheduleError: null,
    });
  });

  // The failure record's own generation check (a failed attempt superseded
  // by a newer revision records nothing) is pinned in
  // cron/scheduled-publish.test.ts (recordScheduleFailure with a stale r).
  it("the generation check: a save between the selection and the run supersedes the run", async () => {
    const documentId = await scheduledAnnouncement("", { publishAt: ago() });
    const lock = t.requireBuilt<{
      readRevision(s: unknown, u: string, d: string): Promise<number>;
    }>("src/utils/document-lock");
    const selected = await lock.readRevision(t.strapi, ANNOUNCEMENT, documentId);
    // A save lands between the selection and the run (and fixes the title).
    await t.strapi
      .documents(ANNOUNCEMENT)
      .update({ documentId, data: { title: "Saved in between" } });
    const result = scheduler.emptyResult();
    const { TransientAttempts } = t.requireBuilt<Schedule>("src/utils/schedule");
    await scheduler.runScheduledDocument(
      t.strapi,
      ANNOUNCEMENT,
      documentId,
      "publish",
      new Date(),
      new TransientAttempts(),
      result,
      selected,
    );
    expect(result.skipped).toEqual([key(ANNOUNCEMENT, documentId)]);
    expect((await draftOf(ANNOUNCEMENT, documentId))?.scheduleError).toBeNull();
    // The next run, with the current revision, publishes it.
    expect((await run()).published).toContain(key(ANNOUNCEMENT, documentId));
  });

  /** The document whose withdrawal the Document Service refuses, as a deadlock would. */
  let failWithdrawalOf: string | null = null;
  let withdrawalFaultAdded = false;
  const failWithdrawal = (documentId: string) => {
    failWithdrawalOf = documentId;
    if (withdrawalFaultAdded) return;
    withdrawalFaultAdded = true;
    const documents = t.strapi.documents as unknown as {
      use(
        middleware: (
          context: { uid: string; action: string; params?: { documentId?: string } },
          next: () => Promise<unknown>,
        ) => Promise<unknown>,
      ): void;
    };
    documents.use(async (context, next) => {
      if (
        context.uid === QUICK_LINK &&
        context.action === "unpublish" &&
        failWithdrawalOf !== null &&
        context.params?.documentId === failWithdrawalOf
      ) {
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      }
      return next();
    });
  };

  it("a withdrawal that keeps failing stays pending: five failures keep unpublishAt; after the backoff it succeeds", async () => {
    const link = await t.strapi.documents(QUICK_LINK).create({
      data: { label: "Stubborn", url: "https://example.org/stubborn" },
      status: "published",
    });
    const documentId = link.documentId;
    await t.strapi.documents(QUICK_LINK).update({
      documentId,
      data: { unpublishAt: ahead(1_000) },
    });
    const { TransientAttempts } = t.requireBuilt<Schedule>("src/utils/schedule");
    const attempts = new TransientAttempts();
    const due = Date.now() + 5_000;
    const at = (ms: number) => new Date(due + ms);
    const isLive = async () =>
      (await rows(QUICK_LINK, documentId)).some((row) => row.publishedAt != null);
    failWithdrawal(documentId);
    try {
      for (let attempt = 1; attempt <= 4; attempt++) {
        const result = await scheduler.runScheduledPublishing(t.strapi, at(0), attempts);
        expect(result.retrying, `attempt ${attempt}`).toContain(key(QUICK_LINK, documentId));
      }
      const fifth = await scheduler.runScheduledPublishing(t.strapi, at(0), attempts);
      expect(fifth.failed).toContain(key(QUICK_LINK, documentId));
      // Failed for good, but not given up: the deadline and the marker stay.
      const failed = await draftOf(QUICK_LINK, documentId);
      expect(failed?.scheduleError).toBe("retryExhausted");
      expect(failed?.unpublishAt).not.toBeNull();
      expect(await isLive()).toBe(true);
      // Inside the 5-minute backoff the withdrawal is not attempted, not
      // even after the fault is gone.
      failWithdrawalOf = null;
      const waiting = await scheduler.runScheduledPublishing(t.strapi, at(60_000), attempts);
      expect([...waiting.unpublished, ...waiting.failed, ...waiting.retrying]).not.toContain(
        key(QUICK_LINK, documentId),
      );
      expect(await isLive()).toBe(true);
    } finally {
      failWithdrawalOf = null;
    }
    const recovered = await scheduler.runScheduledPublishing(t.strapi, at(6 * 60_000), attempts);
    expect(recovered.unpublished).toContain(key(QUICK_LINK, documentId));
    expect(await rows(QUICK_LINK, documentId)).toEqual([
      expect.objectContaining({ publishedAt: null, unpublishAt: null, scheduleError: null }),
    ]);
  });

  it("the clock is read after the lock: a run that reaches a quick link after its unpublishAt does not publish it", async () => {
    const start = Date.now();
    const link = await t.strapi.documents(QUICK_LINK).create({
      data: {
        label: "Late run",
        url: "https://example.org/late-run",
        publishAt: new Date(start - 1_000).toISOString(),
        unpublishAt: new Date(start + 30_000).toISOString(),
      },
    });
    // Selected at the start (publishAt due, window open); by the time the
    // run holds the document's lock a minute has passed.
    const result = await scheduler.runScheduledPublishing(
      t.strapi,
      new Date(start),
      new (t.requireBuilt<Schedule>("src/utils/schedule").TransientAttempts)(),
      () => new Date(start + 60_000),
    );
    expect(result.expired).toContain(key(QUICK_LINK, link.documentId));
    expect(result.published).not.toContain(key(QUICK_LINK, link.documentId));
    expect(await rows(QUICK_LINK, link.documentId)).toEqual([
      expect.objectContaining({
        publishedAt: null,
        publishAt: null,
        unpublishAt: null,
        scheduleError: "windowExpired",
      }),
    ]);
  });

  // ---------------------------------------------------------------------------
  // Issue #73: the withdrawal selection has two tiers (healthy ones in
  // deadline order; failing ones through a reserved quota of 10 per run
  // from a keyset cursor), so failing withdrawals never starve a healthy one.

  /** The unpublishes the Document Service saw, and the documents it refuses. */
  const unpublishFault = {
    attempted: [] as string[],
    refuse: new Set<string>(),
    stall: new Set<string>(),
  };
  let unpublishFaultAdded = false;
  const watchUnpublishes = () => {
    unpublishFault.attempted = [];
    if (unpublishFaultAdded) return;
    unpublishFaultAdded = true;
    const { NotPublishableError } = t.requireBuilt<{
      NotPublishableError: new (keys: readonly string[]) => Error;
    }>("src/utils/publish-readiness");
    const documents = t.strapi.documents as unknown as {
      use(
        middleware: (
          context: { uid: string; action: string; params?: { documentId?: string } },
          next: () => Promise<unknown>,
        ) => Promise<unknown>,
      ): void;
    };
    documents.use(async (context, next) => {
      const documentId = context.params?.documentId ?? "";
      if (context.uid === QUICK_LINK && context.action === "unpublish") {
        unpublishFault.attempted.push(documentId);
        // A permanent failure: recorded once, then the withdrawal backs off.
        if (unpublishFault.refuse.has(documentId)) throw new NotPublishableError(["url"]);
        if (unpublishFault.stall.has(documentId)) {
          throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
        }
      }
      return next();
    });
  };

  /**
   * `count` published quick links with a passed withdrawal, written raw (as
   * a long-running instance accumulates them): `failed` ones carry the
   * scheduleError of an earlier failure, the others none. Returns their
   * documentIds in draft-row id order (the retry tier's cursor order).
   */
  const seedWithdrawals = async (prefix: string, count: number, failed: boolean) => {
    const earlier = new Date(Date.now() - 60 * 60_000);
    const data: Record<string, unknown>[] = [];
    for (let index = 0; index < count; index += 1) {
      const documentId = `${prefix}${String(index).padStart(24 - prefix.length, "0")}`;
      const base = { documentId, label: `${prefix} ${index}`, url: "https://example.org/73" };
      data.push(
        { ...base, publishedAt: earlier },
        {
          ...base,
          publishedAt: null,
          unpublishAt: earlier,
          scheduleError: failed ? "notPublishable" : null,
        },
      );
    }
    const query = t.strapi.db.query(QUICK_LINK) as unknown as {
      createMany(params: { data: Record<string, unknown>[] }): Promise<unknown>;
    };
    for (let start = 0; start < data.length; start += 500) {
      await query.createMany({ data: data.slice(start, start + 500) });
    }
    const drafts = await t.strapi.db.query(QUICK_LINK).findMany({
      where: { documentId: { $startsWith: prefix }, publishedAt: null },
      select: ["documentId"],
      orderBy: { id: "asc" },
    });
    return drafts.map((row) => row.documentId as string);
  };
  const removeSeeded = (prefix: string) =>
    (
      t.strapi.db.query(QUICK_LINK) as unknown as {
        deleteMany(params: { where: Record<string, unknown> }): Promise<unknown>;
      }
    ).deleteMany({ where: { documentId: { $startsWith: prefix } } });
  const failingDue = (now: Date) =>
    t.strapi.db.query(QUICK_LINK).count({
      where: {
        publishedAt: null,
        unpublishAt: { $notNull: true, $lte: now },
        scheduleError: { $notNull: true },
      },
    });

  it("#73: 2,001 permanently failing earlier withdrawals do not keep a healthy later one visible", async () => {
    watchUnpublishes();
    const failing = await seedWithdrawals("it73fail", 2_001, true);
    unpublishFault.refuse = new Set(failing);
    try {
      const healthy = await t.strapi.documents(QUICK_LINK).create({
        data: { label: "Healthy", url: "https://example.org/healthy" },
        status: "published",
      });
      await t.strapi.documents(QUICK_LINK).update({
        documentId: healthy.documentId,
        data: { unpublishAt: ahead(1_000) },
      });
      const now = new Date(Date.now() + 5_000);
      const result = await scheduler.runScheduledPublishing(t.strapi, now, newAttempts());
      expect(result.unpublished).toContain(key(QUICK_LINK, healthy.documentId));
      expect(await rows(QUICK_LINK, healthy.documentId)).toEqual([
        expect.objectContaining({ publishedAt: null, unpublishAt: null }),
      ]);
      // The reserved quota tried ten of the failures, the oldest first, and
      // they stay pending (live, deadline kept).
      expect(result.failed).toEqual(failing.slice(0, 10).map((id) => key(QUICK_LINK, id)));
      expect(
        await t.strapi.db.query(QUICK_LINK).count({
          where: { documentId: { $startsWith: "it73fail" }, publishedAt: { $notNull: true } },
        }),
      ).toBe(2_001);
    } finally {
      unpublishFault.refuse = new Set();
      await removeSeeded("it73fail");
    }
  }, 300_000);

  it("#73: with tier 1 kept full, every ready failure is attempted within ⌈N/10⌉ runs and the cursor skips none", async () => {
    watchUnpublishes();
    const now = new Date(Date.now() + 5_000);
    expect(await failingDue(now)).toBe(0);
    const failing = await seedWithdrawals("it73retry", 25, true);
    // 60 due withdrawals without a failure that fail transiently: tier 1 stays full.
    const stalled = await seedWithdrawals("it73stall", 60, false);
    unpublishFault.refuse = new Set(failing);
    unpublishFault.stall = new Set(stalled);
    try {
      const attempts = newAttempts();
      // Three failures still back off: examined, passed over, never attempted.
      const waiting = new Set([failing[2], failing[11], failing[19]]);
      for (const documentId of waiting) {
        attempts.deferWithdrawal(
          QUICK_LINK,
          documentId,
          now,
          await revisionOf(QUICK_LINK, documentId),
        );
      }
      const ready = failing.filter((documentId) => !waiting.has(documentId));
      const runs = Math.ceil(ready.length / 10);
      const perRun: string[][] = [];
      for (let n = 0; n < runs; n += 1) {
        const before = unpublishFault.attempted.length;
        const result = await scheduler.runScheduledPublishing(t.strapi, now, attempts);
        const attempted = unpublishFault.attempted.slice(before);
        // Tier 1 got every slot the retry tier left.
        expect(attempted.filter((id) => stalled.includes(id))).toHaveLength(
          SCHEDULE_BATCH - result.failed.length,
        );
        perRun.push(attempted.filter((id) => failing.includes(id)));
      }
      expect(perRun).toEqual([ready.slice(0, 10), ready.slice(10, 20), ready.slice(20)]);
      expect(perRun.flat().filter((id) => waiting.has(id))).toEqual([]);
    } finally {
      unpublishFault.refuse = new Set();
      unpublishFault.stall = new Set();
      await removeSeeded("it73retry");
      await removeSeeded("it73stall");
    }
  }, 300_000);
});
