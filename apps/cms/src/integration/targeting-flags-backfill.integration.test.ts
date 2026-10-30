import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_ENV, contentManager } from "./admin-api.test.helper";
import {
  createTestDatabase,
  createTestStrapi,
  testEngines,
  type TestDatabase,
  type TestStrapi,
} from "./harness.test.helper";

/**
 * The targeting-flag backfill (decision 06 §N9, amendment row A5; batch 15
 * item 6 with plan review finding 1) on the real schemas:
 *   - legacy rows with NULL flags get them, and a Content Manager unlink
 *     afterwards keeps the item restricted;
 *   - the batch-14 discard regression: an item restricted only by its flag
 *     whose draft lost the column on the old image (the exact state the old
 *     model's "Discard changes" leaves, set here with raw SQL) gets it back
 *     from its published twin at the next boot, and a real publish then
 *     copies the restricted value.
 * Flags only: whether a republish notifies anybody is lane 15D's suite (S4).
 */

const ANNOUNCEMENT = "api::announcement.announcement";
const EVENT = "api::event.event";

interface Backfill {
  backfillTargetingFlags(strapi: unknown): Promise<Record<string, number>>;
}

interface Notify {
  __fanoutsSettledForTest(): Promise<void>;
}

describe.each(testEngines())("the targeting-flag backfill on %s", (engine) => {
  let database: TestDatabase;
  let t: TestStrapi;
  let engineering: { id: number; documentId: string };

  beforeAll(async () => {
    database = await createTestDatabase(engine);
    t = await createTestStrapi({ database, env: ADMIN_ENV });
    engineering = t.fixtures.departments.engineering as { id: number; documentId: string };
  });

  afterAll(async () => {
    await t?.stop();
    await database?.drop();
  });

  const flags = async (table: "events" | "announcements", documentId: string) => {
    const rows = await t.database.sql<Record<string, unknown>>(
      `SELECT published_at, ${table === "events" ? "notify_audience" : "audience, retarget_required"} FROM ${table} WHERE document_id = ? ORDER BY id`,
      [documentId],
    );
    return rows.map((row) =>
      table === "events"
        ? [row.published_at === null ? "draft" : "published", row.notify_audience]
        : [
            row.published_at === null ? "draft" : "published",
            row.audience,
            row.retarget_required === null ? null : Boolean(row.retarget_required),
          ],
    );
  };

  const backfill = () =>
    t.requireBuilt<Backfill>("src/utils/targeting-flags-backfill").backfillTargetingFlags(t.strapi);

  it("legacy rows with NULL flags get them; a panel unlink afterwards keeps them restricted", async () => {
    const event = await t.strapi.documents(EVENT).create({
      data: {
        title: "Legacy event",
        start: "2026-11-02T08:00:00.000Z",
        departments: [engineering.documentId],
      },
      status: "published",
    });
    const announcement = await t.strapi.documents(ANNOUNCEMENT).create({
      data: { title: "Legacy announcement", audience: "all", department: engineering.documentId },
      status: "published",
    });
    // The pre-upgrade state: the columns came up NULL, the announcement says 'all' next to its target.
    await t.database.sql("UPDATE events SET notify_audience = NULL WHERE document_id = ?", [
      event.documentId,
    ]);
    await t.database.sql(
      "UPDATE announcements SET audience = 'all', retarget_required = NULL WHERE document_id = ?",
      [announcement.documentId],
    );
    await backfill();
    expect(await flags("events", event.documentId)).toEqual([
      ["draft", "departments"],
      ["published", "departments"],
    ]);
    expect(await flags("announcements", announcement.documentId)).toEqual([
      ["draft", "departments", null],
      ["published", "departments", null],
    ]);

    // The admin panel unlinks the department and publishes: still restricted.
    const panel = await contentManager(t);
    const unlinkEvent = await panel.publish(EVENT, event.documentId, {
      departments: { connect: [], disconnect: [{ documentId: engineering.documentId }] },
    });
    expect(unlinkEvent.status, unlinkEvent.text).toBe(200);
    const unlinkAnnouncement = await panel.publish(ANNOUNCEMENT, announcement.documentId, {
      department: { connect: [], disconnect: [{ documentId: engineering.documentId }] },
    });
    expect(unlinkAnnouncement.status, unlinkAnnouncement.text).toBe(200);
    const eventRows = await t.strapi.db
      .query(EVENT)
      .findMany({ where: { documentId: event.documentId }, populate: { departments: true } });
    expect(eventRows.map((row) => (row.departments as unknown[]).length)).toEqual([0, 0]);
    expect((await flags("events", event.documentId)).map((row) => row[1])).toEqual([
      "departments",
      "departments",
    ]);
    expect((await flags("announcements", announcement.documentId)).map((row) => row[1])).toEqual([
      "departments",
      "departments",
    ]);
  });

  it("the batch-14 discard regression: the next boot restores the lost value from the twin; a publish copies it", async () => {
    // An event restricted only by its flag (its departments were deleted)
    // and an announcement carrying the re-target marker.
    const event = await t.strapi.documents(EVENT).create({
      data: { title: "Flag-only event", start: "2026-11-03T08:00:00.000Z" },
      status: "published",
    });
    const announcement = await t.strapi.documents(ANNOUNCEMENT).create({
      data: { title: "Marked announcement", audience: "departments" },
      status: "published",
    });
    // The publishes' notification fan-out runs after the commit. Since Strapi
    // 5.60 skips the entry-event re-read when nothing listens, the writes
    // below met it on SQLite ("database is locked"); let it finish first.
    await t.requireBuilt<Notify>("src/utils/notify").__fanoutsSettledForTest();
    await t.database.sql(
      "UPDATE events SET notify_audience = 'departments' WHERE document_id = ?",
      [event.documentId],
    );
    await t.database.sql("UPDATE announcements SET retarget_required = ? WHERE document_id = ?", [
      true,
      announcement.documentId,
    ]);
    // The old image's "Discard changes": the draft row comes back without the columns.
    await t.database.sql(
      "UPDATE events SET notify_audience = NULL WHERE document_id = ? AND published_at IS NULL",
      [event.documentId],
    );
    await t.database.sql(
      "UPDATE announcements SET retarget_required = NULL WHERE document_id = ? AND published_at IS NULL",
      [announcement.documentId],
    );

    // The roll-forward: a restart runs the backfill at boot.
    await t.stop();
    t = await createTestStrapi({ database, env: ADMIN_ENV, fixtures: false });
    expect(await flags("events", event.documentId)).toEqual([
      ["draft", "departments"],
      ["published", "departments"],
    ]);
    expect((await flags("announcements", announcement.documentId)).map((row) => row[2])).toEqual([
      true,
      true,
    ]);

    // A real publish then copies the restricted values to the new published rows.
    await t.strapi
      .documents(EVENT)
      .update({ documentId: event.documentId, data: { title: "Republished" } });
    await t.strapi.documents(EVENT).publish({ documentId: event.documentId });
    await t.strapi.documents(ANNOUNCEMENT).publish({ documentId: announcement.documentId });
    expect(await flags("events", event.documentId)).toEqual([
      ["draft", "departments"],
      ["published", "departments"],
    ]);
    expect((await flags("announcements", announcement.documentId)).map((row) => row[2])).toEqual([
      true,
      true,
    ]);
    // And the backfill finds nothing more to do.
    expect(Object.values(await backfill()).every((count) => count === 0)).toBe(true);
  }, 300_000);
});
