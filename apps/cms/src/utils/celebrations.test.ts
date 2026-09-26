import { describe, expect, it } from "vitest";

import {
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  parseWindowDays,
  planCelebrations,
  type CelebrationUser,
} from "./celebrations";
import { parsePlainDate, todayIn } from "./time";

/**
 * FX46 planner, run by `pnpm test:tz` under several process zones: every
 * input is a calendar date, so no zone may move a card by a day.
 */

const user = (id: number, fields: Partial<CelebrationUser>): CelebrationUser => ({
  id,
  displayName: `User ${id}`,
  username: `user${id}`,
  jobTitle: "Engineer",
  avatar: null,
  department: { id: 1, name: "Engineering" },
  ...fields,
});

const today = (key: string) => parsePlainDate(key);

describe("planCelebrations", () => {
  it("emits the birthday date as the calendar day itself (kudos.ts emitted the previous day)", () => {
    const [card] = planCelebrations(
      [user(1, { birthday: "1990-10-01", birthdayVisible: true })],
      today("2026-09-24"),
      30,
    );
    expect(card).toEqual({
      user: {
        id: 1,
        displayName: "User 1",
        username: "user1",
        jobTitle: "Engineer",
        avatar: null,
        department: { id: 1, name: "Engineering" },
      },
      type: "birthday",
      date: "2026-10-01",
      daysUntil: 7,
    });
  });

  it("uses 'today' in APP_TIME_ZONE: 22:30Z on Sep 30 is already Oct 1 in Berlin", () => {
    const berlinToday = todayIn("Europe/Berlin", "2026-09-30T22:30:00Z");
    const [card] = planCelebrations(
      [user(1, { birthday: "1990-10-01", birthdayVisible: true })],
      berlinToday,
      30,
    );
    expect(card).toMatchObject({ type: "birthday", date: "2026-10-01", daysUntil: 0 });
  });

  it("wraps into the next year", () => {
    const cards = planCelebrations(
      [
        user(1, { birthday: "1985-01-03", birthdayVisible: true }),
        user(2, { hireDate: "2020-01-02" }),
      ],
      today("2026-12-30"),
      7,
    );
    expect(cards).toEqual([
      expect.objectContaining({ type: "work-anniversary", years: 7, daysUntil: 3 }),
      expect.objectContaining({ type: "birthday", date: "2027-01-03", daysUntil: 4 }),
    ]);
  });

  it("puts a Feb 29 birthday on Feb 28 in a non-leap year and on Feb 29 in a leap year", () => {
    const leap = [user(1, { birthday: "2000-02-29", birthdayVisible: true })];
    expect(planCelebrations(leap, today("2027-02-20"), 30)[0]).toMatchObject({
      date: "2027-02-28",
      daysUntil: 8,
    });
    expect(planCelebrations(leap, today("2027-02-28"), 30)[0]).toMatchObject({ date: "2027-02-28", daysUntil: 0 });
    expect(planCelebrations(leap, today("2028-02-20"), 30)[0]).toMatchObject({ date: "2028-02-29", daysUntil: 9 });
    // Past Feb 28 in a non-leap year: the next one is Feb 29 of the leap year.
    expect(planCelebrations(leap, today("2027-03-01"), 366)[0]).toMatchObject({ date: "2028-02-29" });
  });

  it("skips anniversaries with fewer than one completed year", () => {
    const cards = planCelebrations(
      [
        user(1, { hireDate: "2026-09-24" }), // hired today
        user(2, { hireDate: "2026-10-10" }), // starts next month
        user(3, { hireDate: "2025-09-24" }), // one year today
      ],
      today("2026-09-24"),
      30,
    );
    expect(cards).toEqual([expect.objectContaining({ user: expect.objectContaining({ id: 3 }), years: 1, daysUntil: 0 })]);
  });

  it("includes both window edges and nothing beyond", () => {
    const users = [
      user(1, { birthday: "1990-09-24", birthdayVisible: true }), // 0 days
      user(2, { birthday: "1990-10-24", birthdayVisible: true }), // 30 days
      user(3, { birthday: "1990-10-25", birthdayVisible: true }), // 31 days
    ];
    expect(planCelebrations(users, today("2026-09-24"), 30).map((c) => c.user.id)).toEqual([1, 2]);
    expect(planCelebrations(users, today("2026-09-24"), 0).map((c) => c.user.id)).toEqual([1]);
  });

  it("never shows hidden birthdays, blocked accounts or unparseable dates", () => {
    const cards = planCelebrations(
      [
        user(1, { birthday: "1990-09-25", birthdayVisible: false }),
        user(2, { birthday: "1990-09-25", birthdayVisible: true, blocked: true }),
        user(3, { hireDate: "2010-09-25", blocked: true }),
        user(4, { birthday: "1990-02-31", birthdayVisible: true }),
        user(5, { hireDate: "not a date" }),
      ],
      today("2026-09-24"),
      30,
    );
    expect(cards).toEqual([]);
  });

  it("carries no email, hire date, anniversary date or birth year", () => {
    const leaky = {
      ...user(1, { birthday: "1990-09-25", birthdayVisible: true, hireDate: "2016-09-26" }),
      email: "someone@example.com",
      phone: "+49 30 1",
    };
    const cards = planCelebrations([leaky], today("2026-09-24"), 30);
    expect(cards).toHaveLength(2);
    const json = JSON.stringify(cards);
    for (const secret of ["someone@example.com", "+49 30 1", "1990", "2016-09-26", "2026-09-26"]) {
      expect(json).not.toContain(secret);
    }
    const anniversary = cards.find((c) => c.type === "work-anniversary");
    expect(Object.keys(anniversary ?? {}).sort()).toEqual(["daysUntil", "type", "user", "years"]);
  });

  it("sorts by daysUntil and keeps the query order for ties", () => {
    const cards = planCelebrations(
      [
        user(1, { birthday: "1990-09-30", birthdayVisible: true }),
        user(2, { hireDate: "2020-09-26" }),
        user(3, { birthday: "1991-09-26", birthdayVisible: true }),
      ],
      today("2026-09-24"),
      30,
    );
    expect(cards.map((c) => `${c.user.id}:${c.type}`)).toEqual(["2:work-anniversary", "3:birthday", "1:birthday"]);
  });
});

describe("parseWindowDays", () => {
  it("clamps to 0..366 and defaults to 30", () => {
    expect(parseWindowDays(undefined)).toBe(DEFAULT_WINDOW_DAYS);
    expect(parseWindowDays("")).toBe(DEFAULT_WINDOW_DAYS);
    expect(parseWindowDays("abc")).toBe(DEFAULT_WINDOW_DAYS);
    expect(parseWindowDays("30")).toBe(30);
    expect(parseWindowDays("0")).toBe(0);
    expect(parseWindowDays("-5")).toBe(0);
    expect(parseWindowDays("7.9")).toBe(7);
    expect(parseWindowDays("100000")).toBe(MAX_WINDOW_DAYS);
  });
});
