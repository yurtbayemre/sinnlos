import { describe, expect, it } from "vitest";
import {
  MAX_DUTY_SHIFTS,
  copyDutyWeek,
  dutyShiftFromTemplate,
  dutyShiftOverlaps,
  dutyShiftsAt,
  dutyShiftsBetween,
  dutyShiftsCode,
  dutyTemplatesCode,
  moveDutyShift,
  pruneDutyShifts,
  validateDutyShifts,
  validateDutyTemplates,
} from "./duty.js";

const BERLIN = "Europe/Berlin";
const shift = (userId: number, startsAt: string, endsAt: string) => ({ userId, startsAt, endsAt });

describe("validateDutyTemplates", () => {
  it("accepts none, trims labels and keeps overnight templates", () => {
    expect(validateDutyTemplates(undefined)).toEqual({ templates: [] });
    expect(
      validateDutyTemplates([
        { label: " Früh ", start: "06:00", end: "14:00" },
        { label: "Nacht", start: "22:00", end: "06:00" },
      ]),
    ).toEqual({
      templates: [
        { label: "Früh", start: "06:00", end: "14:00" },
        { label: "Nacht", start: "22:00", end: "06:00" },
      ],
    });
  });

  it("refuses a blank or repeated label, a bad time and equal start and end", () => {
    for (const raw of [
      [{ label: " ", start: "06:00", end: "14:00" }],
      [{ label: "Früh", start: "6:00", end: "14:00" }],
      [{ label: "Früh", start: "24:00", end: "06:00" }],
      [{ label: "Früh", start: "06:00", end: "06:00" }],
      [
        { label: "Früh", start: "06:00", end: "14:00" },
        { label: "Früh", start: "07:00", end: "15:00" },
      ],
      "Früh",
    ]) {
      expect(validateDutyTemplates(raw), JSON.stringify(raw)).toHaveProperty("error");
      expect(dutyTemplatesCode(raw)).toBe("invalid");
    }
    expect(dutyTemplatesCode([{ label: "x".repeat(61), start: "06:00", end: "14:00" }])).toBe(
      "tooLong",
    );
    expect(dutyTemplatesCode([])).toBeNull();
  });
});

describe("validateDutyShifts", () => {
  it("normalises instants to UTC and sorts by start", () => {
    expect(
      validateDutyShifts([
        shift(2, "2026-10-21T14:00:00+02:00", "2026-10-21T22:00:00+02:00"),
        shift(1, "2026-10-21T04:00:00.000Z", "2026-10-21T12:00:00.000Z"),
      ]),
    ).toEqual({
      shifts: [
        shift(1, "2026-10-21T04:00:00.000Z", "2026-10-21T12:00:00.000Z"),
        shift(2, "2026-10-21T12:00:00.000Z", "2026-10-21T20:00:00.000Z"),
      ],
    });
  });

  it("refuses a missing user, an offset-less time, an end before the start and an overlong shift", () => {
    const cases: [unknown, string][] = [
      [[{ startsAt: "2026-10-21T04:00:00Z", endsAt: "2026-10-21T12:00:00Z" }], "invalid"],
      [[shift(1, "2026-10-21T06:00:00", "2026-10-21T14:00:00")], "invalid"],
      [[shift(1, "2026-10-21T12:00:00Z", "2026-10-21T04:00:00Z")], "endBeforeStart"],
      [[shift(1, "2026-10-01T00:00:00Z", "2026-10-16T00:00:00Z")], "endBeforeStart"],
      [
        Array(MAX_DUTY_SHIFTS + 1).fill(shift(1, "2026-10-21T04:00:00Z", "2026-10-21T12:00:00Z")),
        "invalid",
      ],
    ];
    for (const [raw, code] of cases) {
      expect(validateDutyShifts(raw)).toHaveProperty("error");
      expect(dutyShiftsCode(raw)).toBe(code);
    }
    expect(dutyShiftsCode(null)).toBeNull();
  });
});

describe("who is on duty", () => {
  const shifts = [
    shift(1, "2026-10-21T04:00:00.000Z", "2026-10-21T12:00:00.000Z"),
    shift(2, "2026-10-21T11:00:00.000Z", "2026-10-21T20:00:00.000Z"),
    shift(3, "2026-10-22T04:00:00.000Z", "2026-10-22T12:00:00.000Z"),
  ];

  it("takes a shift from its start up to, not including, its end", () => {
    expect(dutyShiftsAt(shifts, new Date("2026-10-21T04:00:00Z")).map((s) => s.userId)).toEqual([
      1,
    ]);
    expect(dutyShiftsAt(shifts, new Date("2026-10-21T11:30:00Z")).map((s) => s.userId)).toEqual([
      1, 2,
    ]);
    expect(dutyShiftsAt(shifts, new Date("2026-10-21T12:00:00Z")).map((s) => s.userId)).toEqual([
      2,
    ]);
  });

  it("lists the shifts touching a window and names overlapping pairs", () => {
    expect(
      dutyShiftsBetween(
        shifts,
        new Date("2026-10-21T19:00:00Z"),
        new Date("2026-10-22T05:00:00Z"),
      ).map((s) => s.userId),
    ).toEqual([2, 3]);
    expect(dutyShiftOverlaps(shifts)).toEqual([[0, 1]]);
  });
});

describe("templates, copying and pruning in APP_TIME_ZONE", () => {
  it("builds a night shift across midnight and across the clock change as one shift", () => {
    const night = { label: "Nacht", start: "22:00", end: "06:00" };
    // 2026-10-25 03:00 CEST becomes 02:00 CET: the night has nine hours.
    expect(dutyShiftFromTemplate(night, "2026-10-24", 7, BERLIN)).toEqual(
      shift(7, "2026-10-24T20:00:00.000Z", "2026-10-25T05:00:00.000Z"),
    );
  });

  it("copies a week at the same wall times, also across the clock change", () => {
    const week = [
      shift(1, "2026-10-19T04:00:00.000Z", "2026-10-19T12:00:00.000Z"),
      shift(2, "2026-10-25T05:00:00.000Z", "2026-10-25T13:00:00.000Z"),
      shift(3, "2026-10-26T05:00:00.000Z", "2026-10-26T13:00:00.000Z"),
    ];
    expect(copyDutyWeek(week, "2026-10-19", BERLIN)).toEqual([
      // 06:00 CEST on Monday becomes 06:00 CET a week later.
      shift(1, "2026-10-26T05:00:00.000Z", "2026-10-26T13:00:00.000Z"),
      shift(2, "2026-11-01T05:00:00.000Z", "2026-11-01T13:00:00.000Z"),
    ]);
    expect(moveDutyShift(week[0], -7, BERLIN)).toEqual(
      shift(1, "2026-10-12T04:00:00.000Z", "2026-10-12T12:00:00.000Z"),
    );
  });

  it("drops shifts that ended more than four weeks ago", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    expect(
      pruneDutyShifts(
        [
          shift(1, "2026-09-01T04:00:00.000Z", "2026-09-01T12:00:00.000Z"),
          shift(2, "2026-10-02T04:00:00.000Z", "2026-10-02T12:00:00.000Z"),
        ],
        now,
      ).map((s) => s.userId),
    ).toEqual([2]);
  });
});
