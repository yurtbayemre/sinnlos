import { describe, expect, it } from "vitest";
import type { AnnouncementEditable, EventEditable, PollEditable } from "@sinnlos/domain";
import { dayStartInstant, plainDateValue, splitInstant, wallTimeInstant } from "./datetime";
import {
  fieldErrorId,
  fieldInputId,
  knownCode,
  MANAGE_ERROR_CODES,
  sortFieldErrors,
} from "./errors";
import {
  announcementValuesFromEditable,
  coerceAnnouncementValues,
  coercePollValues,
  coerceScheduleValues,
  eventValuesFromEditable,
  pollValuesFromEditable,
  scheduleValuesFromEditable,
} from "./values";

/**
 * The /manage form values (decision 06 §L4): the date inputs in
 * APP_TIME_ZONE (reject mode), the values a form starts from, the coercion
 * of untrusted Server Action arguments, and the sorting of refused fields.
 */

const BERLIN = "Europe/Berlin";

describe("datetime inputs", () => {
  it("converts a date and a time in the zone, both empty to null", () => {
    expect(wallTimeInstant("2026-11-03", "10:00", BERLIN)).toEqual({
      value: "2026-11-03T09:00:00.000Z",
    });
    expect(wallTimeInstant("", "", BERLIN)).toEqual({ value: null });
  });

  it("needs both halves, well-formed", () => {
    expect(wallTimeInstant("2026-11-03", "", BERLIN)).toEqual({ code: "required" });
    expect(wallTimeInstant("", "10:00", BERLIN)).toEqual({ code: "required" });
    expect(wallTimeInstant("2026-02-30", "10:00", BERLIN)).toEqual({ code: "invalidDate" });
    expect(wallTimeInstant("2026-11-03", "25:00", BERLIN)).toEqual({ code: "invalidInstant" });
    expect(wallTimeInstant("2026-11-03", "10:00:30", BERLIN)).toEqual({ code: "invalidInstant" });
  });

  it("takes the fallback date for a time alone", () => {
    expect(wallTimeInstant("", "12:00", BERLIN, { fallbackDate: "2026-11-03" })).toEqual({
      value: "2026-11-03T11:00:00.000Z",
    });
  });

  it("refuses the repeated and the skipped hour", () => {
    expect(wallTimeInstant("2026-10-25", "02:30", BERLIN)).toEqual({ code: "timeRepeated" });
    expect(wallTimeInstant("2027-03-28", "02:30", BERLIN)).toEqual({ code: "timeSkipped" });
  });

  it("gives a day's first instant, and plain dates as they are", () => {
    expect(dayStartInstant("2026-10-25", BERLIN)).toEqual({ value: "2026-10-24T22:00:00.000Z" });
    expect(dayStartInstant("", BERLIN)).toEqual({ value: null });
    expect(dayStartInstant("", BERLIN, { required: true })).toEqual({ code: "required" });
    expect(plainDateValue(" 2026-11-15 ")).toEqual({ value: "2026-11-15" });
    expect(plainDateValue("15.11.2026")).toEqual({ code: "invalidDate" });
  });

  it("splits a stored instant into the zone's date and HH:mm", () => {
    expect(splitInstant("2026-10-25T01:30:00.000Z", BERLIN)).toEqual({
      date: "2026-10-25",
      time: "02:30",
    });
    expect(splitInstant(null, BERLIN)).toEqual({ date: "", time: "" });
    expect(splitInstant("not an instant", BERLIN)).toEqual({ date: "", time: "" });
  });
});

describe("values from editable", () => {
  const base = {
    documentId: "annc00000000000000000001",
    version: "3",
    status: "draft" as const,
    publishedAt: null,
    updatedAt: "2026-10-12T08:00:00.000Z",
    roleClass: "moderator" as const,
  };

  it("an announcement's expiry as date and time, the absent moderator-only fields off", () => {
    const editable: AnnouncementEditable = {
      ...base,
      roleClass: "departmentAuthor",
      title: "Hi",
      body: null,
      expiresAt: "2026-11-30T17:00:00.000Z",
      department: "deptengineering000000000",
      team: null,
      audienceRoles: ["member"],
      ownerDepartment: { documentId: "deptengineering000000000", name: "Engineering" },
      needsRetarget: false,
    };
    expect(announcementValuesFromEditable(editable, BERLIN)).toEqual({
      title: "Hi",
      body: "",
      pinned: false,
      expiresDate: "2026-11-30",
      expiresTime: "18:00",
      department: "deptengineering000000000",
      team: "",
      audienceRoles: ["member"],
      requiresAck: false,
      ackDeadline: "",
    });
  });

  it("an all-day event as its first and last day; a timed one as dates and times", () => {
    const allDay: EventEditable = {
      ...base,
      title: "Offsite",
      description: null,
      start: "2026-10-23T22:00:00.000Z",
      end: "2026-10-25T23:00:00.000Z",
      allDay: true,
      location: null,
      url: null,
      rsvpEnabled: true,
      capacity: 40,
      departments: [],
      ownerDepartment: null,
      needsRetarget: false,
    };
    expect(eventValuesFromEditable(allDay, BERLIN)).toMatchObject({
      allDay: true,
      startDate: "2026-10-24",
      startTime: "",
      endDate: "2026-10-26",
      endTime: "",
      capacity: "40",
    });
    expect(
      eventValuesFromEditable(
        { ...allDay, allDay: false, start: "2026-11-03T09:00:00.000Z", end: null },
        BERLIN,
      ),
    ).toMatchObject({ startDate: "2026-11-03", startTime: "10:00", endDate: "", endTime: "" });
  });

  it("a poll's closing day, and the guest switches normalised", () => {
    const poll: PollEditable = {
      ...base,
      question: "Q?",
      options: ["A", "B"],
      closesAt: "2026-10-25T22:59:59.000Z",
      anonymous: false,
      departments: [],
      visibleToGuests: false,
      guestsCanVote: true,
      needsRetarget: false,
      hasVotes: false,
    };
    expect(pollValuesFromEditable(poll, BERLIN)).toMatchObject({
      closesDay: "2026-10-25",
      visibleToGuests: false,
      guestsCanVote: false,
    });
  });

  it("the schedule as date and time inputs", () => {
    expect(
      scheduleValuesFromEditable(
        { publishAt: "2026-11-01T07:00:00.000Z", unpublishAt: null },
        BERLIN,
      ),
    ).toEqual({
      publishDate: "2026-11-01",
      publishTime: "08:00",
      unpublishDate: "",
      unpublishTime: "",
    });
  });
});

describe("coercion of Server Action arguments", () => {
  it("types every field and drops what is not of its type", () => {
    expect(
      coerceAnnouncementValues({
        title: 42,
        body: "ok",
        pinned: "true",
        department: " deptx ",
        audienceRoles: ["member", 7, "member", " ", null],
        requiresAck: true,
        extra: "ignored",
      }),
    ).toEqual({
      title: "",
      body: "ok",
      pinned: false,
      expiresDate: "",
      expiresTime: "",
      department: "deptx",
      team: "",
      audienceRoles: ["member"],
      requiresAck: true,
      ackDeadline: "",
    });
    expect(coerceAnnouncementValues(null).title).toBe("");
    expect(coerceAnnouncementValues([1, 2]).audienceRoles).toEqual([]);
  });

  it("keeps a poll's blank and repeated answers in place (votes point at an index)", () => {
    expect(coercePollValues({ options: ["A", "", "A"] }).options).toEqual(["A", "", "A"]);
  });

  it("caps lists and texts", () => {
    const many = coercePollValues({ options: Array.from({ length: 500 }, (_, i) => `${i}`) });
    expect(many.options.length).toBeLessThanOrEqual(60);
    const long = coerceAnnouncementValues({ body: "x".repeat(300_000) });
    expect(long.body.length).toBe(210_000);
    expect(coerceScheduleValues({ publishDate: 1 })).toEqual({
      publishDate: "",
      publishTime: "",
      unpublishDate: "",
      unpublishTime: "",
    });
  });
});

describe("refused fields", () => {
  const shown = new Set(["title", "body", "start"]);

  it("sorts the form's own fields, _form, and what the form cannot show", () => {
    expect(sortFieldErrors({ title: "required", start: "timeSkipped" }, shown)).toEqual({
      fields: { title: "required", start: "timeSkipped" },
      form: null,
      unshown: false,
    });
    expect(sortFieldErrors({ _form: "neverPublished" }, shown)).toEqual({
      fields: {},
      form: "neverPublished",
      unshown: false,
    });
    // A refused moderator-only key, or a missing status: a web bug, a generic text.
    expect(sortFieldErrors({ pinned: "invalid", title: "tooLong" }, shown)).toEqual({
      fields: { title: "tooLong" },
      form: null,
      unshown: true,
    });
    expect(sortFieldErrors({ status: "required" }, shown).unshown).toBe(true);
    expect(sortFieldErrors(undefined, shown)).toEqual({ fields: {}, form: null, unshown: false });
  });

  it("reads a code the web does not know as invalid", () => {
    expect(sortFieldErrors({ body: "somethingNew" }, shown).fields).toEqual({ body: "invalid" });
    expect(knownCode("frozenAfterVotes")).toBe("frozenAfterVotes");
    expect(knownCode("constructor")).toBe("invalid");
  });

  it("knows every cms code and the two reject-mode codes", () => {
    expect(MANAGE_ERROR_CODES).toContain("neverPublished");
    expect(MANAGE_ERROR_CODES).toContain("timeRepeated");
    expect(MANAGE_ERROR_CODES).toContain("timeSkipped");
    expect(new Set(MANAGE_ERROR_CODES).size).toBe(MANAGE_ERROR_CODES.length);
  });

  it("names a field's control and error by the form and the field", () => {
    expect(fieldInputId("event", "start")).toBe("event-start");
    expect(fieldErrorId("event", "start")).toBe("event-start-error");
  });
});
