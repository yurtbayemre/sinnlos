import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";

/**
 * FEATURES_OFF (v0.28, plan rev2 §6) over real HTTP. The policies read the
 * env per request, so each case switches `process.env.FEATURES_OFF` in this
 * process (the cms runs in it) and restores it; production needs a restart
 * for the crons and the web. Also the always-on changes of v0.28: no admin
 * update/delete of acknowledgements, notifications own-only for every role,
 * and the admin's unread count.
 */

const NOTIFICATION = "api::notification.notification";

describe.each(testEngines())("module and feature switches on %s", (engine) => {
  let t: TestStrapi;
  let event: Row;
  let ack: Row;

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    event = await t.strapi.documents("api::event.event").create({
      data: {
        title: "IT switch party",
        start: "2030-01-10T10:00:00.000Z",
        end: "2030-01-10T12:00:00.000Z",
      },
      status: "published",
    });
    const announcement = await t.strapi.documents("api::announcement.announcement").create({
      data: { title: "IT ack me", audience: "all", requiresAck: true },
      status: "published",
    });
    ack = await t.strapi.db.query("api::acknowledgement.acknowledgement").create({
      data: {
        user: t.fixtures.users.member.id,
        targetType: "announcement",
        targetDocumentId: announcement.documentId,
      },
    });
    await t.strapi.db.query(NOTIFICATION).create({
      data: { type: "comment", title: "for member", recipient: t.fixtures.users.member.id },
    });
  });

  afterEach(() => {
    delete process.env.FEATURES_OFF;
  });

  afterAll(async () => {
    await t?.stop();
  });

  it("a module off answers 404 on every route of its APIs, whoever calls; on, they answer", async () => {
    const eventRoutes = [
      "/api/events",
      `/api/events/${event.documentId}`,
      `/api/events/${event.documentId}/ics`,
      `/api/event-rsvps/summary?targets=${event.documentId}`,
    ];
    for (const path of eventRoutes) expect((await t.api("member", path)).status, path).toBe(200);
    process.env.FEATURES_OFF = "events";
    for (const caller of ["admin_role", "member"] as const) {
      for (const path of eventRoutes) {
        expect((await t.api(caller, path)).status, `${caller} ${path}`).toBe(404);
      }
    }
    process.env.FEATURES_OFF = "training,polls,marketplace,duty-plans,kpis";
    for (const path of [
      "/api/courses",
      "/api/lessons/x/player",
      "/api/courses/report",
      "/api/poll-results",
      "/api/classifieds",
      "/api/duty-plans",
      "/api/kpis",
    ]) {
      expect((await t.api("admin_role", path)).status, path).toBe(404);
    }
    // The base stays.
    expect((await t.api("member", "/api/announcements")).status).toBe(200);
  });

  it("celebrations and kudos switch independently", async () => {
    process.env.FEATURES_OFF = "kudos";
    expect((await t.api("member", "/api/kudos-entries")).status).toBe(404);
    expect((await t.api("member", "/api/celebrations")).status).toBe(200);
    process.env.FEATURES_OFF = "celebrations";
    expect((await t.api("member", "/api/kudos-entries")).status).toBe(200);
    expect((await t.api("member", "/api/celebrations")).status).toBe(404);
  });

  it("read-confirmations off: no new confirmation, and admin_role reads its own rows only", async () => {
    const all = await t.api<{ data: Row[] }>("admin_role", "/api/acknowledgements");
    expect(all.body.data.map((row) => row.id)).toContain(ack.id);
    process.env.FEATURES_OFF = "read-confirmations";
    const create = await t.api("member", "/api/acknowledgements", {
      json: { data: { targetType: "announcement", targetDocumentId: "x" } },
    });
    expect(create.status).toBe(404);
    const own = await t.api<{ data: Row[] }>("admin_role", "/api/acknowledgements");
    expect(own.status).toBe(200);
    expect(own.body.data).toEqual([]);
  });

  it("training-reports off closes the reports, not the courses", async () => {
    expect((await t.api("admin_role", "/api/courses/report")).status).toBe(200);
    process.env.FEATURES_OFF = "training-reports";
    expect((await t.api("admin_role", "/api/courses/report")).status).toBe(404);
    expect((await t.api("admin_role", "/api/courses/x/report")).status).toBe(404);
    expect((await t.api("member", "/api/courses")).status).toBe(200);
  });

  it("search-logging off: the log answers 204 and stores nothing; the summary is closed", async () => {
    const logs = t.strapi.db.query("api::search-log.search-log");
    const before = await logs.count({});
    process.env.FEATURES_OFF = "search-logging";
    const post = await t.api("member", "/api/search-logs", {
      json: { data: { term: "stapler", resultCount: 3 } },
    });
    expect(post.status).toBe(204);
    expect(await logs.count({})).toBe(before);
    expect((await t.api("admin_role", "/api/search-logs/summary?days=30")).status).toBe(404);
    delete process.env.FEATURES_OFF;
    expect(
      (
        await t.api("member", "/api/search-logs", {
          json: { data: { term: "stapler", resultCount: 3 } },
        })
      ).status,
    ).toBe(204);
    expect(await logs.count({})).toBe(before + 1);
  });

  it("always: no admin update or delete of a confirmation", async () => {
    for (const method of ["PUT", "DELETE"]) {
      const res = await t.api("admin_role", `/api/acknowledgements/${ack.documentId}`, {
        method,
        ...(method === "PUT" ? { json: { data: { targetDocumentId: "y" } } } : {}),
      });
      expect(res.status, method).toEqual(expect.toBeOneOf([404, 405]));
    }
  });

  it("always: notifications are own-only for admin_role too; the unread count is a number", async () => {
    const admin = await t.api<{ data: Row[] }>("admin_role", "/api/notifications");
    expect(admin.status).toBe(200);
    // The fan-outs of the fixtures may have notified admin_role too; never the member's row.
    expect(admin.body.data.map((row) => row.title)).not.toContain("for member");
    const count = await t.api<{ count: number }>("admin_role", "/api/notifications/unread-count");
    expect(count.status).toBe(200);
    expect(count.body.count).toBe(
      await t.strapi.db.query(NOTIFICATION).count({ where: { readAt: null } }),
    );
    expect(count.body.count).toBeGreaterThan(0);
    expect((await t.api("member", "/api/notifications/unread-count")).status).toBe(403);
  });
});
