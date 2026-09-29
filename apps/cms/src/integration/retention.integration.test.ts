import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { todayIn } from "../utils/time";
import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";

/**
 * The LF07 retention janitors on the real query engine (owner answer
 * 2026-09-29 (b)); cron/registry.ts runs them at 03:40 and 03:45, after
 * the 03:00 backup. The rules are pinned as pure functions in
 * cron/*.test.ts; this pins what only a database shows:
 *   - notification-janitor: the where clause selects the same rows on
 *     SQLite and Postgres (instants stored per the datetime contract), and
 *     `deleteMany` takes the recipient and actor link rows with it
 *     (ON DELETE CASCADE), while unread rows, recently read rows and
 *     fan-out anchor rows stay;
 *   - classified-janitor: the plain-date comparison, and the purge through
 *     the Document Service, whose delete lifecycles remove the ad's
 *     marketplace images after the commit (an admin upload stays).
 */

const NOTIFICATION = "api::notification.notification";
const CLASSIFIED = "api::classified.classified";
const FILE = "plugin::upload.file";
const DAY = 86_400_000;

interface Janitors {
  pruneNotifications(strapi: unknown, now?: Date): Promise<number>;
}
interface ClassifiedJanitor {
  purgeExpiredClassifieds(strapi: unknown): Promise<number>;
}

describe.each(testEngines())("retention janitors on %s", (engine) => {
  let t: TestStrapi;

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
  });

  afterAll(async () => {
    await t?.stop();
  });

  it("prunes read notifications 90 days after reading, with their link rows, and nothing else", async () => {
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
    const recipient = t.fixtures.users.member.id;
    const actor = t.fixtures.users.editor.id;
    const make = async (title: string, fields: Record<string, unknown>) => {
      const row = await t.strapi.db.query(NOTIFICATION).create({
        data: { type: "comment", title, recipient, actor, ...fields },
      });
      // createdAt is stamped by the engine on create; set it afterwards.
      if (fields.createdAt) {
        await t.strapi.db.query(NOTIFICATION).update({
          where: { id: row.id },
          data: { createdAt: fields.createdAt },
        });
      }
      return row;
    };
    const old = await make("IT read long ago", { readAt: ago(100), createdAt: ago(120) });
    const recent = await make("IT read recently", { readAt: ago(10), createdAt: ago(200) });
    const unread = await make("IT unread", { readAt: null, createdAt: ago(400) });
    const anchor = await make("IT anchor", {
      type: "announcement",
      readAt: ago(300),
      createdAt: ago(300),
      sourceType: "announcement",
      sourceDocumentId: "itann000000000000000000",
    });

    const { pruneNotifications } = t.requireBuilt<Janitors>("src/cron/prune-notifications");
    await expect(pruneNotifications(t.strapi, now)).resolves.toBe(1);

    const left = await t.strapi.db.query(NOTIFICATION).findMany({
      where: { title: { $startsWith: "IT " } },
      select: ["id"],
    });
    expect(left.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [recent.id, unread.id, anchor.id].sort((a, b) => a - b),
    );
    for (const link of ["notifications_recipient_lnk", "notifications_actor_lnk"]) {
      const count = (id: number) =>
        t.strapi.db.query(link).count({ where: { notification_id: id } });
      expect(await count(old.id), link).toBe(0);
      expect(await count(recent.id), link).toBe(1);
      expect(await count(anchor.id), link).toBe(1);
    }
    // The rest stays on the next night.
    await expect(pruneNotifications(t.strapi, now)).resolves.toBe(0);
  });

  it("purges ads 90 days after their last day through the Document Service, with their images", async () => {
    const author = t.fixtures.users.member.id;
    const file = async (name: string, uploadedBy: number | null) =>
      t.strapi.db.query(FILE).create({
        data: {
          name,
          hash: `it_${name.replace(/\W/g, "_")}_${engine}`,
          ext: ".png",
          mime: "image/png",
          size: 1,
          url: `/uploads/it_${name}`,
          provider: "local",
          provider_metadata: uploadedBy === null ? null : { uploadedBy },
        },
      });
    const photo = await file("photo.png", author);
    const adminUpload = await file("logo.png", null);
    const ad = async (title: string, expiresAt: string, images: number[] = []): Promise<Row> =>
      t.strapi.documents(CLASSIFIED).create({
        data: {
          title,
          description: "retention",
          category: "sale",
          expiresAt,
          author,
          images,
        },
      });
    const expired = await ad("IT long expired", "2025-01-01", [photo.id, adminUpload.id]);
    const recent = await ad("IT expired lately", todayIn().toString());
    const listed = await ad("IT still listed", "2099-12-31");

    const { purgeExpiredClassifieds } = t.requireBuilt<ClassifiedJanitor>(
      "src/cron/purge-expired-classifieds",
    );
    await expect(purgeExpiredClassifieds(t.strapi)).resolves.toBe(1);

    const left = await t.strapi.db.query(CLASSIFIED).findMany({
      where: { title: { $startsWith: "IT " } },
      select: ["documentId"],
    });
    expect(left.map((row) => row.documentId).sort()).toEqual(
      [recent.documentId, listed.documentId].sort(),
    );
    expect(expired.documentId).toBeTruthy();
    // The image cleanup runs after the delete's commit.
    await expect
      .poll(async () => t.strapi.db.query(FILE).count({ where: { id: photo.id } }), {
        timeout: 10_000,
      })
      .toBe(0);
    expect(await t.strapi.db.query(FILE).count({ where: { id: adminUpload.id } })).toBe(1);
  });
});
