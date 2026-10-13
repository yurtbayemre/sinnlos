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
  runScheduledPublishing(strapi: unknown, now?: Date): Promise<RunResult>;
  runScheduledDocument(
    strapi: unknown,
    uid: string,
    documentId: string,
    pass: "publish" | "unpublish",
    now: Date,
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
});
