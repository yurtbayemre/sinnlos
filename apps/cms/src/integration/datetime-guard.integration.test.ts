import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_ENV, contentManager, type ContentManager } from "./admin-api.test.helper";
import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";

/**
 * DT-OFFSETLESS (decision 06 §F; batch 15 item 1; spike 6 S6.1-S6.4) on
 * the real cms: the guard is the first Document Service middleware, so it
 * answers the generic content API, the Content Manager and in-process
 * writers alike, before any transaction, while the admin panel's own
 * writes (ISO-Z datetimes, YYYY-MM-DD dates) keep working. S6.3 (the
 * allowlisted routes refuse the value earlier with the field 400) belongs
 * to lane 15A.
 */

const EVENT = "api::event.event";
const ANNOUNCEMENT = "api::announcement.announcement";
const POLL = "api::poll.poll";

interface ErrorBody {
  error?: { status: number; name: string; message: string; details?: { keys?: string[] } };
  data?: { documentId: string; closesAt?: string };
}

describe.each(testEngines())("the offset-less datetime guard on %s", (engine) => {
  let t: TestStrapi;
  let panel: ContentManager;

  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: ADMIN_ENV });
    panel = await contentManager(t);
  });

  afterAll(async () => {
    await t?.stop();
  });

  it("S6.1 without the guard, Strapi reads an offset-less value in the process zone (db layer)", async () => {
    const row = await t.strapi.db.query(EVENT).create({
      data: { title: "raw", start: "2026-10-01T09:00", documentId: "itdtraw00000000000000000" },
    });
    const back = await t.strapi.db.query(EVENT).findOne({ where: { id: row.id } });
    // 09:00 in the UTC process, not 09:00 Berlin: what the guard keeps out of every Document Service write.
    expect(back?.start).toBe("2026-10-01T09:00:00.000Z");
    await t.strapi.db.query(EVENT).delete({ where: { id: row.id } });
  });

  it("S6.2 the content API: an open-payload route (poll create) answers the guard's 400", async () => {
    const offsetless = await t.api<ErrorBody>("editor", "/api/polls?status=published", {
      json: { data: { question: "Q?", options: ["a", "b"], closesAt: "2026-10-01T09:00" } },
    });
    expect(offsetless.status, offsetless.text).toBe(400);
    expect(offsetless.body.error?.details?.keys).toEqual(["closesAt"]);
    const zoned = await t.api<ErrorBody>("editor", "/api/polls?status=published", {
      json: {
        data: { question: "Q?", options: ["a", "b"], closesAt: "2026-10-01T09:00:00+02:00" },
      },
    });
    expect(zoned.status, zoned.text).toBe(201);
    const stored = await t.strapi.db.query(POLL).findOne({
      where: { documentId: zoned.body.data?.documentId, publishedAt: { $notNull: true } },
    });
    expect(stored?.closesAt).toBe("2026-10-01T07:00:00.000Z");
  });

  it("S6.4 the admin panel: create, save, publish and clone keep working; dates pass", async () => {
    const created = await panel.create(EVENT, {
      title: "Panel event",
      start: "2026-11-02T08:00:00.000Z",
      allDay: false,
    });
    expect(created.status, created.text).toBe(201);
    const documentId = created.body.data.documentId;
    const saved = await panel.update(EVENT, documentId, {
      title: "Panel event v2",
      start: "2026-11-02T09:00:00.000Z",
      end: "2026-11-02T10:00:00.000Z",
    });
    expect(saved.status, saved.text).toBe(200);
    const published = await panel.publish(EVENT, documentId);
    expect(published.status, published.text).toBe(200);
    const cloned = await panel.clone(EVENT, documentId, { title: "Panel event clone" });
    expect(cloned.status, cloned.text).toBe(200);
    const withDate = await panel.create(ANNOUNCEMENT, {
      title: "Panel announcement",
      requiresAck: true,
      ackDeadline: "2026-10-15",
    });
    expect(withDate.status, withDate.text).toBe(201);
  });

  it("S6.4 an offset-less value from an admin client answers 400 with a readable message", async () => {
    const created = await panel.create(EVENT, { title: "E", start: "2026-11-02T08:00:00.000Z" });
    const documentId = created.body.data.documentId;
    const offsetless = await panel.update(EVENT, documentId, { start: "2026-11-02T09:00" });
    expect(offsetless.status).toBe(400);
    expect(offsetless.body.error?.message).toBe(
      "Instants need Z or an offset (e.g. 2026-10-01T07:00:00.000Z): start",
    );
    expect(offsetless.body.error?.details).toMatchObject({ keys: ["start"] });
    const viaPublish = await panel.createAndPublish(EVENT, {
      title: "E2",
      start: "2026-11-02 09:00",
    });
    expect(viaPublish.status).toBe(400);
    // Nothing was stored by either.
    const row = await t.strapi.db
      .query(EVENT)
      .findOne({ where: { documentId, publishedAt: null } });
    expect(row?.start).toBe("2026-11-02T08:00:00.000Z");
  });

  it("an in-process Document Service write is refused the same way (schedule fields included)", async () => {
    await expect(
      t.strapi.documents(ANNOUNCEMENT).create({
        data: { title: "Scheduled", publishAt: "2026-12-01T09:00" },
      }),
    ).rejects.toMatchObject({
      name: "ValidationError",
      details: { keys: ["publishAt"] },
    });
    const ok = await t.strapi.documents(ANNOUNCEMENT).create({
      data: { title: "Scheduled", publishAt: "2026-12-01T09:00:00+01:00" },
    });
    expect(ok.publishAt).toBe("2026-12-01T08:00:00.000Z");
  });
});
