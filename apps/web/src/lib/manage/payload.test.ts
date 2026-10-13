import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT_DEPARTMENT_AUTHOR_FIELDS,
  EVENT_DEPARTMENT_AUTHOR_FIELDS,
  MAX_MARKDOWN_LENGTH,
} from "@sinnlos/domain";
import {
  buildAnnouncementPayload,
  buildEventPayload,
  buildPollPayload,
  buildQuickLinkPayload,
  buildSchedulePayload,
  type PayloadContext,
} from "./payload";
import {
  emptyAnnouncementValues,
  emptyEventValues,
  emptyPollValues,
  emptyQuickLinkValues,
  emptyScheduleValues,
  type AnnouncementValues,
  type EventValues,
  type PollValues,
} from "./values";

/**
 * The payload builders of the /manage actions (decision 06 §L3 steps 2-4,
 * §L4; batch 15 plan 15C "the payload builders"): the shared domain checks,
 * the reject-mode dates in APP_TIME_ZONE, the class's keys only, targeting
 * keys only on a change, a department author's pinned targeting.
 */

const BERLIN = "Europe/Berlin";
const NOW = Date.parse("2026-10-13T10:00:00.000Z");
const ENG = "deptengineering000000000";
const SALES = "deptsales000000000000000";

const moderator = (overrides: Partial<PayloadContext> = {}): PayloadContext => ({
  mode: "create",
  roleClass: "moderator",
  timeZone: BERLIN,
  now: NOW,
  ownDepartment: null,
  ...overrides,
});
const departmentAuthor = (overrides: Partial<PayloadContext> = {}): PayloadContext => ({
  ...moderator(),
  roleClass: "departmentAuthor",
  ownDepartment: ENG,
  ...overrides,
});

const announcement = (patch: Partial<AnnouncementValues> = {}): AnnouncementValues => ({
  ...emptyAnnouncementValues(),
  title: "Canteen closed",
  body: "On **Friday**.",
  ...patch,
});
const event = (patch: Partial<EventValues> = {}): EventValues => ({
  ...emptyEventValues(),
  title: "Town hall",
  startDate: "2026-11-03",
  startTime: "10:00",
  ...patch,
});

describe("announcement payloads", () => {
  it("a moderator's create carries every field of the class, dates in APP_TIME_ZONE", () => {
    const built = buildAnnouncementPayload(
      announcement({
        pinned: true,
        expiresDate: "2026-11-30",
        expiresTime: "18:00",
        department: ENG,
        audienceRoles: ["member", "team_lead"],
        requiresAck: true,
        ackDeadline: "2026-11-15",
      }),
      null,
      moderator(),
    );
    expect(built).toEqual({
      ok: true,
      data: {
        title: "Canteen closed",
        body: "On **Friday**.",
        pinned: true,
        expiresAt: "2026-11-30T17:00:00.000Z",
        department: ENG,
        team: null,
        audienceRoles: ["member", "team_lead"],
        requiresAck: true,
        ackDeadline: "2026-11-15",
      },
    });
  });

  it("a department author never sends a moderator-only key, and the department is pinned (§N4)", () => {
    const built = buildAnnouncementPayload(
      // Whatever the form held: pinned, ack and another department.
      announcement({
        pinned: true,
        requiresAck: true,
        ackDeadline: "2026-11-15",
        department: SALES,
      }),
      null,
      departmentAuthor(),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.keys(built.data).sort()).toEqual(
      [...ANNOUNCEMENT_DEPARTMENT_AUTHOR_FIELDS].sort(),
    );
    expect(built.data.department).toBe(ENG);
    for (const key of ["pinned", "requiresAck", "ackDeadline", "publishAt", "ownerDepartment"]) {
      expect(built.data, key).not.toHaveProperty(key);
    }
  });

  it("an update sends only the changed fields, and the targeting only when it changed", () => {
    const initial = announcement({ department: ENG, audienceRoles: ["member"] });
    const titleOnly = buildAnnouncementPayload(
      { ...initial, title: "Canteen open" },
      initial,
      moderator({ mode: "update" }),
    );
    expect(titleOnly).toEqual({ ok: true, data: { title: "Canteen open" } });

    // A list in another order is no change.
    const reordered = buildAnnouncementPayload(
      { ...initial, audienceRoles: ["member"] },
      { ...initial, audienceRoles: ["member"] },
      moderator({ mode: "update" }),
    );
    expect(reordered).toEqual({ ok: true, data: {} });

    // One targeting key changed: all three go, so the cms re-derives the flags.
    const team = buildAnnouncementPayload(
      { ...initial, team: "teamplatform000000000000" },
      initial,
      moderator({ mode: "update" }),
    );
    expect(team).toEqual({
      ok: true,
      data: { department: ENG, team: "teamplatform000000000000", audienceRoles: ["member"] },
    });
  });

  it("an explicit re-target sends the unchanged targeting (lowers the marker, §N9)", () => {
    const initial = announcement({ department: ENG });
    const built = buildAnnouncementPayload(
      initial,
      initial,
      moderator({ mode: "update", retarget: true }),
    );
    expect(built).toEqual({
      ok: true,
      data: { department: ENG, team: null, audienceRoles: [] },
    });
  });

  describe("an item that needs re-targeting is never made company-wide by accident (Codex review)", () => {
    // A surviving department, a deleted team, no roles: choosing the empty
    // department used to send department, team and roles empty, which the
    // cms reads as "everyone".
    const initial = announcement({ department: ENG });
    const everyone = announcement({ department: "", team: "", audienceRoles: [] });

    it("refuses targeting that reaches everyone without the confirmation", () => {
      expect(
        buildAnnouncementPayload(
          everyone,
          initial,
          moderator({ mode: "update", needsRetarget: true }),
        ),
      ).toEqual({ ok: false, fields: { department: "confirmAudience" } });
      // Roles alone still reach a role across the company.
      expect(
        buildAnnouncementPayload(
          announcement({ department: "", audienceRoles: ["member"] }),
          initial,
          moderator({ mode: "update", needsRetarget: true }),
        ),
      ).toEqual({ ok: false, fields: { department: "confirmAudience" } });
      expect(
        buildEventPayload(
          event({ departments: [] }),
          event({ departments: [ENG] }),
          moderator({ mode: "update", needsRetarget: true }),
        ),
      ).toMatchObject({ ok: false, fields: { departments: "confirmAudience" } });
    });

    it("sends it with the confirmation, and for an item that does not need re-targeting", () => {
      for (const ctx of [
        moderator({ mode: "update", needsRetarget: true, retarget: true }),
        moderator({ mode: "update" }),
      ]) {
        expect(buildAnnouncementPayload(everyone, initial, ctx)).toEqual({
          ok: true,
          data: { department: null, team: null, audienceRoles: [] },
        });
      }
    });

    it("lets a narrowing re-target through: another department, or a team", () => {
      const ctx = moderator({ mode: "update", needsRetarget: true });
      expect(buildAnnouncementPayload(announcement({ department: SALES }), initial, ctx)).toEqual({
        ok: true,
        data: { department: SALES, team: null, audienceRoles: [] },
      });
      expect(
        buildAnnouncementPayload(
          announcement({ department: "", team: "teamplatform000000000000" }),
          initial,
          ctx,
        ),
      ).toEqual({
        ok: true,
        data: { department: null, team: "teamplatform000000000000", audienceRoles: [] },
      });
      // No targeting change: nothing is sent, nothing widens.
      expect(buildAnnouncementPayload(initial, initial, ctx)).toEqual({ ok: true, data: {} });
    });
  });

  it("refuses a missing title, an overlong body and a deadline without the confirmation", () => {
    const built = buildAnnouncementPayload(
      announcement({
        title: "   ",
        body: "x".repeat(MAX_MARKDOWN_LENGTH + 1),
        ackDeadline: "2026-11-15",
      }),
      null,
      moderator(),
    );
    expect(built).toEqual({
      ok: false,
      fields: { title: "required", body: "tooLong", ackDeadline: "ackDeadlineWithoutAck" },
    });
  });

  it("refuses a malformed deadline and an expiry without its time", () => {
    const built = buildAnnouncementPayload(
      announcement({ requiresAck: true, ackDeadline: "2026-13-01", expiresDate: "2026-11-30" }),
      null,
      moderator(),
    );
    expect(built).toEqual({
      ok: false,
      fields: { expiresAt: "required", ackDeadline: "invalidDate" },
    });
  });

  it("refuses an expiry on a clock-change time (reject mode)", () => {
    const repeated = buildAnnouncementPayload(
      announcement({ expiresDate: "2026-10-25", expiresTime: "02:30" }),
      null,
      moderator(),
    );
    expect(repeated).toEqual({ ok: false, fields: { expiresAt: "timeRepeated" } });
    const skipped = buildAnnouncementPayload(
      announcement({ expiresDate: "2027-03-28", expiresTime: "02:30" }),
      null,
      moderator(),
    );
    expect(skipped).toEqual({ ok: false, fields: { expiresAt: "timeSkipped" } });
  });

  it("does not re-check an unchanged expiry on an update (a legacy clock-change time)", () => {
    const initial = announcement({ expiresDate: "2026-10-25", expiresTime: "02:30" });
    const built = buildAnnouncementPayload(
      { ...initial, title: "New title" },
      initial,
      moderator({ mode: "update" }),
    );
    expect(built).toEqual({ ok: true, data: { title: "New title" } });
  });
});

describe("event payloads", () => {
  it("sends a timed event's start and end as instants of APP_TIME_ZONE", () => {
    const built = buildEventPayload(
      event({ endDate: "2026-11-03", endTime: "11:30", location: " Hall A ", url: "" }),
      null,
      moderator(),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.data).toMatchObject({
      start: "2026-11-03T09:00:00.000Z",
      end: "2026-11-03T10:30:00.000Z",
      allDay: false,
      location: "Hall A",
      url: null,
      capacity: null,
      departments: [],
    });
  });

  it("ends a timed event on its start day when only an end time is given", () => {
    const built = buildEventPayload(event({ endTime: "12:00" }), null, moderator());
    expect(built.ok && built.data.end).toBe("2026-11-03T11:00:00.000Z");
  });

  it("sends an all-day event as local midnights, the end at its last day's (zonedDayStart)", () => {
    // Across the Berlin fall-back day: 2026-10-25 has 25 hours.
    const built = buildEventPayload(
      event({ allDay: true, startDate: "2026-10-24", startTime: "", endDate: "2026-10-26" }),
      null,
      moderator(),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.data.start).toBe("2026-10-23T22:00:00.000Z");
    expect(built.data.end).toBe("2026-10-25T23:00:00.000Z");
    // A one-day event has no end.
    const oneDay = buildEventPayload(
      event({ allDay: true, startDate: "2027-03-28", startTime: "" }),
      null,
      moderator(),
    );
    expect(oneDay.ok && oneDay.data.start).toBe("2027-03-27T23:00:00.000Z");
    expect(oneDay.ok && oneDay.data.end).toBeNull();
  });

  it.each([
    ["2026-10-25", "02:30", BERLIN, "timeRepeated"],
    ["2027-03-28", "02:30", BERLIN, "timeSkipped"],
    ["2027-10-31", "02:30", BERLIN, "timeRepeated"],
    ["2026-09-27", "02:30", "Pacific/Auckland", "timeSkipped"],
    ["2027-04-04", "02:30", "Pacific/Auckland", "timeRepeated"],
  ])("refuses a start at %s %s in %s (%s)", (date, time, zone, code) => {
    const built = buildEventPayload(
      event({ startDate: date, startTime: time }),
      null,
      moderator({ timeZone: zone }),
    );
    expect(built).toEqual({ ok: false, fields: { start: code } });
  });

  it("refuses an end before the start, a missing start, a bad link and capacity", () => {
    expect(
      buildEventPayload(event({ endDate: "2026-11-02", endTime: "10:00" }), null, moderator()),
    ).toEqual({ ok: false, fields: { end: "endBeforeStart" } });
    expect(buildEventPayload(event({ startDate: "", startTime: "" }), null, moderator())).toEqual({
      ok: false,
      fields: { start: "required" },
    });
    expect(
      buildEventPayload(event({ url: "javascript:alert(1)", capacity: "0" }), null, moderator()),
    ).toEqual({ ok: false, fields: { url: "invalidUrl", capacity: "invalid" } });
    expect(buildEventPayload(event({ capacity: "2.5" }), null, moderator())).toEqual({
      ok: false,
      fields: { capacity: "invalid" },
    });
  });

  it("a department author's event notifies their department, pinned, and never schedules", () => {
    const built = buildEventPayload(event({ departments: [SALES] }), null, departmentAuthor());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.data.departments).toEqual([ENG]);
    expect(Object.keys(built.data).sort()).toEqual([...EVENT_DEPARTMENT_AUTHOR_FIELDS].sort());
  });

  it("an update sends a moved start alone, and the end too when it follows the start's day", () => {
    const initial = event({ endDate: "2026-11-03", endTime: "11:00" });
    expect(
      buildEventPayload({ ...initial, startTime: "09:00" }, initial, moderator({ mode: "update" })),
    ).toEqual({ ok: true, data: { start: "2026-11-03T08:00:00.000Z" } });
    // A new start day leaves an explicit end alone, even one in a repeated
    // clock-change hour (it is not re-validated).
    const explicit = event({ endDate: "2026-10-25", endTime: "02:30" });
    expect(
      buildEventPayload(
        { ...explicit, startDate: "2026-10-24" },
        explicit,
        moderator({ mode: "update" }),
      ),
    ).toEqual({ ok: true, data: { start: "2026-10-24T08:00:00.000Z" } });
    // An end given as a time alone ends on the start's day: a new start day moves it.
    const sameDay = event({ endTime: "11:00" });
    expect(
      buildEventPayload(
        { ...sameDay, startDate: "2026-11-04" },
        sameDay,
        moderator({ mode: "update" }),
      ),
    ).toEqual({
      ok: true,
      data: { start: "2026-11-04T09:00:00.000Z", end: "2026-11-04T10:00:00.000Z" },
    });
  });
});

describe("quick-link payloads", () => {
  const link = { ...emptyQuickLinkValues(), label: "Handbook", url: "/wiki/handbook" };

  it("takes an internal path or an http(s) URL, an icon key, a category and an order", () => {
    expect(
      buildQuickLinkPayload({ ...link, icon: "BookOpen", order: "20" }, null, moderator()),
    ).toEqual({
      ok: true,
      data: {
        label: "Handbook",
        url: "/wiki/handbook",
        icon: "BookOpen",
        category: "tools",
        order: 20,
        departments: [],
      },
    });
  });

  it("refuses a protocol-relative URL, an unknown icon, category and order", () => {
    expect(
      buildQuickLinkPayload(
        { ...link, url: "//evil.example", icon: "Rocket", category: "games", order: "10001" },
        null,
        moderator(),
      ),
    ).toEqual({
      ok: false,
      fields: { url: "invalidUrl", icon: "invalid", category: "invalid", order: "invalid" },
    });
  });

  it("is moderator-only: a department author's class has no quick-link fields", () => {
    expect(buildQuickLinkPayload(link, null, departmentAuthor())).toEqual({ ok: true, data: {} });
  });
});

describe("poll payloads", () => {
  const poll = (patch: Partial<PollValues> = {}): PollValues => ({
    ...emptyPollValues(),
    question: "Which day?",
    options: ["Monday", "Friday"],
    ...patch,
  });

  it("closes at 23:59:59 of the chosen day in APP_TIME_ZONE (pollClosesAtForDay)", () => {
    const built = buildPollPayload(poll({ closesDay: "2026-10-25" }), null, moderator());
    expect(built.ok && built.data.closesAt).toBe("2026-10-25T22:59:59.000Z");
  });

  it("trims the answers and keeps their order", () => {
    const built = buildPollPayload(poll({ options: [" Monday ", "Friday"] }), null, moderator());
    expect(built.ok && built.data.options).toEqual(["Monday", "Friday"]);
  });

  it.each([
    [["Only"], "optionCount"],
    [Array.from({ length: 21 }, (_, i) => `Answer ${i}`), "optionCount"],
    [["Yes", " Yes "], "optionDuplicate"],
    [["Yes", ""], "required"],
    [["Yes", "x".repeat(201)], "tooLong"],
  ])("refuses the answers %j (%s)", (options, code) => {
    expect(buildPollPayload(poll({ options }), null, moderator())).toEqual({
      ok: false,
      fields: { options: code },
    });
  });

  it("accepts 20 answers of 200 characters (the domain bounds, K7)", () => {
    const options = Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(200, "x"));
    expect(buildPollPayload(poll({ options }), null, moderator()).ok).toBe(true);
  });

  it("never sends answers or anonymity once someone voted (frozenAfterVotes)", () => {
    const initial = poll();
    const built = buildPollPayload(
      { ...initial, options: ["Tuesday", "Friday"], anonymous: true, closesDay: "2026-11-01" },
      initial,
      { ...moderator({ mode: "update" }), hasVotes: true },
    );
    expect(built).toEqual({ ok: true, data: { closesAt: "2026-11-01T22:59:59.000Z" } });
  });

  it("does not re-send unchanged answers (a legacy answer over 200 characters stays)", () => {
    const initial = poll({ options: ["Yes", "x".repeat(300)] });
    const built = buildPollPayload(
      { ...initial, question: "Still?" },
      initial,
      moderator({ mode: "update" }),
    );
    expect(built).toEqual({ ok: true, data: { question: "Still?" } });
  });

  it("guest voting only with visibility", () => {
    const built = buildPollPayload(
      poll({ visibleToGuests: false, guestsCanVote: true }),
      null,
      moderator(),
    );
    expect(built.ok && built.data).toMatchObject({ visibleToGuests: false, guestsCanVote: false });
  });
});

describe("schedule payloads (§D)", () => {
  const schedule = (patch: Partial<ReturnType<typeof emptyScheduleValues>>) => ({
    ...emptyScheduleValues(),
    ...patch,
  });

  it("sends publishAt (and a quick link's unpublishAt) as instants of APP_TIME_ZONE", () => {
    expect(
      buildSchedulePayload(
        "quickLink",
        schedule({
          publishDate: "2026-11-01",
          publishTime: "08:00",
          unpublishDate: "2026-12-01",
          unpublishTime: "08:00",
        }),
        moderator(),
      ),
    ).toEqual({
      ok: true,
      data: { publishAt: "2026-11-01T07:00:00.000Z", unpublishAt: "2026-12-01T07:00:00.000Z" },
    });
    // Announcements have no unpublishAt.
    expect(
      buildSchedulePayload(
        "announcement",
        schedule({ publishDate: "2026-11-01", publishTime: "08:00" }),
        moderator(),
      ),
    ).toEqual({ ok: true, data: { publishAt: "2026-11-01T07:00:00.000Z" } });
  });

  it("removes a schedule with nulls", () => {
    expect(buildSchedulePayload("quickLink", emptyScheduleValues(), moderator())).toEqual({
      ok: true,
      data: { publishAt: null, unpublishAt: null },
    });
  });

  it("refuses a time less than a minute ahead, an end before the start, an expiry before it", () => {
    expect(
      buildSchedulePayload(
        "event",
        schedule({ publishDate: "2026-10-13", publishTime: "12:00" }),
        moderator(),
      ),
    ).toEqual({ ok: false, fields: { publishAt: "scheduleInPast" } });
    expect(
      buildSchedulePayload(
        "quickLink",
        schedule({
          publishDate: "2026-11-02",
          publishTime: "08:00",
          unpublishDate: "2026-11-01",
          unpublishTime: "08:00",
        }),
        moderator(),
      ),
    ).toEqual({ ok: false, fields: { unpublishAt: "unpublishBeforePublish" } });
    expect(
      buildSchedulePayload(
        "announcement",
        schedule({ publishDate: "2026-11-02", publishTime: "08:00" }),
        moderator(),
        { expiresAt: "2026-11-01T00:00:00.000Z" },
      ),
    ).toEqual({ ok: false, fields: { publishAt: "expiresBeforePublish" } });
  });

  it("refuses a clock-change time (reject mode, the next real changes)", () => {
    expect(
      buildSchedulePayload(
        "announcement",
        schedule({ publishDate: "2027-03-28", publishTime: "02:30" }),
        moderator(),
      ),
    ).toEqual({ ok: false, fields: { publishAt: "timeSkipped" } });
    expect(
      buildSchedulePayload(
        "announcement",
        schedule({ publishDate: "2027-10-31", publishTime: "02:30" }),
        moderator(),
      ),
    ).toEqual({ ok: false, fields: { publishAt: "timeRepeated" } });
  });

  it("is moderator-only: a department author's schedule carries nothing", () => {
    expect(
      buildSchedulePayload(
        "announcement",
        schedule({ publishDate: "2026-11-01", publishTime: "08:00" }),
        departmentAuthor(),
      ),
    ).toEqual({ ok: true, data: {} });
  });
});
