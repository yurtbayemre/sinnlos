import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  authoringApi,
  notifiedUserIds,
  settleFanouts,
  type AuthoringApi,
} from "./authoring.test.helper";
import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";

/**
 * Events through the v2 write model (deep-dive decision 06 §B1, §B6;
 * batch 15 lane 15A; the spike suite S10.5-S10.9 ported onto the
 * authoring controller) on SQLite and Postgres 16:
 *   - the organizer is the caller and is not notified; the departments
 *     steer the fan-out only (events stay calendar-wide), and
 *     `notifyAudience` is derived from them;
 *   - value and cross-field rules with their codes (offset instants, end
 *     before start, all-day local midnights in APP_TIME_ZONE across the DST
 *     day, capacity, http(s) URL);
 *   - an RSVP create answers 200; lowering the capacity keeps the seats.
 */
const E = "api::event.event";
const P = "events";

describe.each(testEngines())("authoring events on %s", (engine) => {
  let t: TestStrapi;
  let api: AuthoringApi;
  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    api = authoringApi(t);
  });
  afterAll(async () => {
    await t?.stop();
  });

  let eventId = "";
  let version = "";
  const rsvp = (role: "member" | "team_lead" | "department_head" | "admin_role", status = "yes") =>
    t.api<{ error?: { message: string } }>(role, "/api/event-rsvps", {
      json: { data: { targetDocumentId: eventId, status } },
    });

  it("S10.5 an editor creates a timed event: the organizer is the caller, Engineering is notified", async () => {
    const res = await api.create(
      "editor",
      P,
      {
        title: "Town hall",
        start: "2026-11-05T15:00:00+01:00",
        end: "2026-11-05T16:30:00+01:00",
        rsvpEnabled: true,
        capacity: 2,
        location: "Room 1",
        url: "https://meet.example.org/townhall",
        departments: [t.fixtures.departments.engineering.documentId],
      },
      "published",
    );
    expect(res.status, res.text).toBe(201);
    eventId = res.body.data.documentId;
    version = res.body.data.version;
    const [row] = await t.strapi.db.query(E).findMany({
      where: { documentId: eventId, publishedAt: { $notNull: true } },
      populate: { organizer: { select: ["id"] } },
    });
    expect((row.organizer as { id: number }).id).toBe(t.fixtures.users.editor.id);
    expect(new Date(row.start as string).toISOString()).toBe("2026-11-05T14:00:00.000Z");
    expect(row.notifyAudience).toBe("departments");
    await settleFanouts(t);
    const staff = (["admin_role", "department_head", "team_lead", "member"] as const)
      .map((role) => t.fixtures.users[role].id)
      .sort((a, b) => a - b);
    expect(await notifiedUserIds(t, eventId)).toEqual(staff);
  });

  it("S10.6 value and cross-field rules answer 400 with their codes", async () => {
    const bad: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ start: "2026-11-05T15:00" }, { keys: ["start"], codes: { start: "invalidInstant" } }],
      [{ end: "2026-11-05T13:00:00Z" }, { keys: ["end"], codes: { end: "endBeforeStart" } }],
      [{ capacity: 0 }, { keys: ["capacity"], codes: { capacity: "invalid" } }],
      [{ capacity: "3" }, { keys: ["capacity"], codes: { capacity: "invalid" } }],
      [{ url: "javascript:alert(1)" }, { keys: ["url"], codes: { url: "invalidUrl" } }],
      [{ organizer: t.fixtures.users.member.id }, { keys: ["organizer"] }],
      [{ notifyAudience: "all" }, { keys: ["notifyAudience"] }],
      [{ departments: ["zzzzzzzzzzzzzzzzzzzzzzzz"] }, { keys: ["departments"] }],
    ];
    for (const [data, details] of bad) {
      const res = await api.update("editor", P, eventId, data, { version });
      expect(res.status, JSON.stringify(data)).toBe(400);
      expect(res.body.error?.details, JSON.stringify(data)).toEqual(details);
    }
  });

  it("S10.7 all-day: start and end must be local midnights of APP_TIME_ZONE, the DST day included", async () => {
    const utc = await api.create(
      "editor",
      P,
      {
        title: "Offsite",
        allDay: true,
        start: "2026-11-02T00:00:00Z",
        end: "2026-11-04T00:00:00Z",
      },
      "published",
    );
    expect(utc.status).toBe(400);
    expect(utc.body.error?.details).toEqual({
      keys: ["end", "start"],
      codes: { end: "notMidnight", start: "notMidnight" },
    });
    const berlin = await api.create(
      "editor",
      P,
      {
        title: "Offsite",
        allDay: true,
        start: "2026-11-02T00:00:00+01:00",
        end: "2026-11-04T00:00:00+01:00",
      },
      "published",
    );
    expect(berlin.status, berlin.text).toBe(201);
    // Switching a timed event to all-day re-checks the STORED start and end.
    const toggle = await api.update("editor", P, eventId, { allDay: true }, { version });
    expect(toggle.status).toBe(400);
    expect(toggle.body.error?.details?.keys).toEqual(["end", "start"]);
    // 2026-10-25 has 25 hours in Berlin; its midnight is +02:00, the next +01:00.
    const dst = await api.create(
      "editor",
      P,
      {
        title: "DST day",
        allDay: true,
        start: "2026-10-25T00:00:00+02:00",
        end: "2026-10-26T00:00:00+01:00",
      },
      "published",
    );
    expect(dst.status, dst.text).toBe(201);
  });

  it("S10.8 an RSVP create answers 200; lowering the capacity keeps the seats; RSVP off keeps the answers", async () => {
    expect((await rsvp("member")).status).toBe(200);
    expect((await rsvp("team_lead")).status).toBe(200);
    const full = await rsvp("department_head");
    expect(full.status).toBe(400);
    expect(full.body.error?.message).toBe("Event is at capacity");

    const lower = await api.update(
      "editor",
      P,
      eventId,
      { capacity: 1 },
      { status: "published", version },
    );
    expect(lower.status, lower.text).toBe(200);
    version = lower.body.data.version;
    const summary = await t.api<{ data: { yesCount: number }[] }>(
      "member",
      `/api/event-rsvps/summary?targets=${eventId}`,
    );
    expect(summary.body.data[0].yesCount).toBe(2);

    const off = await api.update(
      "editor",
      P,
      eventId,
      { rsvpEnabled: false, capacity: null },
      { status: "published", version },
    );
    expect(off.status).toBe(200);
    version = off.body.data.version;
    expect((await rsvp("admin_role")).status).toBe(400);
    expect(
      await t.strapi.db
        .query("api::event-rsvp.event-rsvp")
        .count({ where: { targetDocumentId: eventId } }),
    ).toBe(2);
  });

  it("S10.9 events are calendar-wide; departments only steer the fan-out; [] notifies everyone", async () => {
    const sales = await api.create(
      "editor",
      P,
      {
        title: "Sales kickoff",
        start: "2026-12-01T09:00:00Z",
        departments: [t.fixtures.departments.sales.documentId],
      },
      "published",
    );
    expect(sales.status).toBe(201);
    const id = sales.body.data.documentId;
    expect((await t.api("member", `/api/events/${id}`)).status).toBe(200);
    expect((await t.api("guest", `/api/events/${id}`)).status).toBe(200);
    await settleFanouts(t);
    expect(await notifiedUserIds(t, id)).toEqual([]);
    const all = await api.update(
      "editor",
      P,
      id,
      { departments: [] },
      { status: "published", version: sales.body.data.version },
    );
    expect(all.status).toBe(200);
    const [row] = await t.strapi.db
      .query(E)
      .findMany({ where: { documentId: id, publishedAt: { $notNull: true } } });
    expect(row.notifyAudience).toBe("all");
    await settleFanouts(t);
    expect(await notifiedUserIds(t, id)).toContain(t.fixtures.users.member.id);
    expect(await notifiedUserIds(t, id)).not.toContain(t.fixtures.users.editor.id);
  });

  it("the form reads the departments as documentIds and the instants as ISO-Z", async () => {
    const form = await api.editable<Record<string, unknown>>("editor", P, eventId);
    expect(form.body.data).toMatchObject({
      title: "Town hall",
      start: "2026-11-05T14:00:00.000Z",
      end: "2026-11-05T15:30:00.000Z",
      allDay: false,
      rsvpEnabled: false,
      capacity: null,
      departments: [t.fixtures.departments.engineering.documentId],
      ownerDepartment: null,
      needsRetarget: false,
      publishAt: null,
      roleClass: "moderator",
    });
  });
});
