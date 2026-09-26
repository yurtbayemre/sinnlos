/**
 * Upcoming birthdays and work anniversaries for GET /api/kudos/celebrations
 * (roadmap FX46; datetime contract, deep-dive decision 04, C7).
 *
 * Pure: users and "today" in, cards out. `today` is a calendar date in
 * APP_TIME_ZONE (the controller passes time.todayIn()), birthdays and hire
 * dates are the users' `date` columns ('YYYY-MM-DD'), and every step stays
 * in calendar-date space, so the result cannot depend on the process zone.
 * (The old controller mixed `new Date('YYYY-MM-DD')`, a UTC midnight, with
 * local getters: in a zone west of UTC every card showed the previous day,
 * and the emitted birthday date was the UTC day of a local midnight.)
 *
 * Rules:
 *  - daysUntil counts whole days from today; the event day itself is 0.
 *  - Feb 29 falls on Feb 28 in non-leap years (time.nextAnnual policy).
 *  - Anniversaries need at least one completed year (a hire date today or in
 *    the future is no anniversary).
 *  - The window is clamped to 0..366 days (default 30).
 *  - Blocked accounts get no card.
 *
 * The response shape is the security boundary (the endpoint answers raw
 * db.query rows through ctx.send, which bypasses the output sanitizer): no
 * email, no hire date or anniversary date, no birth year.
 */
import { nextAnnual, tryParsePlainDate, type PlainDate } from "./time";

export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 366;

export interface CelebrationUser {
  id: number;
  displayName?: string | null;
  username?: string | null;
  jobTitle?: string | null;
  avatar?: unknown;
  department?: unknown;
  hireDate?: string | null;
  birthday?: string | null;
  birthdayVisible?: boolean | null;
  blocked?: boolean | null;
}

/** The only user fields a celebration card may carry. */
export interface CelebrationCardUser {
  id: number;
  displayName: string | null | undefined;
  username: string | null | undefined;
  jobTitle: string | null | undefined;
  avatar: unknown;
  department: unknown;
}

export type Celebration =
  | { user: CelebrationCardUser; type: "work-anniversary"; years: number; daysUntil: number }
  | { user: CelebrationCardUser; type: "birthday"; date: string; daysUntil: number };

/** ?window= as a whole number of days in [0, 366]; anything else is the default. */
export function parseWindowDays(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_WINDOW_DAYS;
  const days = Number(value);
  if (!Number.isFinite(days)) return DEFAULT_WINDOW_DAYS;
  return Math.min(MAX_WINDOW_DAYS, Math.max(0, Math.floor(days)));
}

function cardUser(user: CelebrationUser): CelebrationCardUser {
  return {
    id: user.id,
    displayName: user.displayName,
    username: user.username,
    jobTitle: user.jobTitle,
    avatar: user.avatar,
    department: user.department,
  };
}

export function planCelebrations(
  users: readonly CelebrationUser[],
  today: PlainDate,
  windowDays: number,
): Celebration[] {
  const upcoming: Celebration[] = [];

  for (const user of users) {
    if (user.blocked === true) continue;

    const hireDate = tryParsePlainDate(user.hireDate);
    if (hireDate) {
      const occurrence = nextAnnual(hireDate, today);
      if (occurrence.years >= 1 && occurrence.daysUntil <= windowDays) {
        // No absolute date on purpose (F2): the occurrence date plus `years`
        // would reveal the exact hire date to the non-privileged fallback
        // role that also holds this grant. The card renders "N years · in M
        // days".
        upcoming.push({
          user: cardUser(user),
          type: "work-anniversary",
          years: occurrence.years,
          daysUntil: occurrence.daysUntil,
        });
      }
    }

    const birthday = user.birthdayVisible === true ? tryParsePlainDate(user.birthday) : null;
    if (birthday) {
      const occurrence = nextAnnual(birthday, today);
      if (occurrence.daysUntil <= windowDays) {
        // No `years` on purpose: the year of birth stays private.
        upcoming.push({
          user: cardUser(user),
          type: "birthday",
          date: occurrence.next.toString(),
          daysUntil: occurrence.daysUntil,
        });
      }
    }
  }

  // Array#sort is stable: equal days keep the users' query order.
  return upcoming.sort((a, b) => a.daysUntil - b.daysUntil);
}
