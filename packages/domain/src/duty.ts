import type { AuthoringFieldCode } from "./authoring/codes.js";
import { isRowId } from "./entry-id.js";
import {
  addDaysToKey,
  instantEpochMs,
  isWallTimeError,
  zonedDateKey,
  zonedTimeOfDay,
  zonedWallTimeToInstant,
} from "./plain-date.js";

/**
 * Duty plans ("Zuständigkeiten", owner decisions of 2026-10-20): one plan per
 * duty (key service, shift lead of a hall …) with its shift templates and
 * its shifts. One rule for every writer: the cms lifecycle applies the
 * validate* functions to every write (admin panel included), the authoring
 * allowlist and the web form the *Code functions.
 *
 * Shifts are instants (Z or an offset), so a night shift across midnight or
 * a clock change is one row; templates are wall times in APP_TIME_ZONE.
 * Several people on one duty at the same time are allowed (the owner wants a
 * hint, not a refusal): dutyShiftOverlaps names them for the form.
 */

/** A shift template: a label and wall times 'HH:mm'; an end at or before the start ends the next day. */
export interface DutyShiftTemplate {
  label: string;
  start: string;
  end: string;
}

/** One shift: who (a user id) and from when to when (instants). */
export interface DutyShift {
  userId: number;
  startsAt: string;
  endsAt: string;
}

/** Most templates per plan. */
export const MAX_DUTY_TEMPLATES = 12;
/** Most shifts per plan: eight weeks of three shifts a day with two people each fit. */
export const MAX_DUTY_SHIFTS = 400;
/** Longest template label. */
export const MAX_DUTY_LABEL = 60;
/** Longest single shift (a key service can run a whole week, Monday to Monday). */
export const MAX_DUTY_SHIFT_DAYS = 14;
/** Shifts that ended this many days ago leave the plan when the web saves it. */
export const DUTY_HISTORY_DAYS = 28;

const DAY_MS = 86_400_000;
const WALL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export type DutyTemplatesResult = { templates: DutyShiftTemplate[] } | { error: string };
export type DutyShiftsResult = { shifts: DutyShift[] } | { error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Templates: missing means none; each needs a unique label and two different wall times. */
export function validateDutyTemplates(raw: unknown): DutyTemplatesResult {
  if (raw == null) return { templates: [] };
  if (!Array.isArray(raw) || raw.length > MAX_DUTY_TEMPLATES) {
    return {
      error: `shiftTemplates: a JSON array of at most ${MAX_DUTY_TEMPLATES} templates is required`,
    };
  }
  const templates: DutyShiftTemplate[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    const label = isRecord(entry) && typeof entry.label === "string" ? entry.label.trim() : "";
    if (!isRecord(entry) || label === "" || label.length > MAX_DUTY_LABEL) {
      return {
        error: `shiftTemplates[${i}]: a label of 1 to ${MAX_DUTY_LABEL} characters is required`,
      };
    }
    const { start, end } = entry;
    if (
      typeof start !== "string" ||
      typeof end !== "string" ||
      !WALL_TIME.test(start) ||
      !WALL_TIME.test(end) ||
      start === end
    ) {
      return { error: `shiftTemplates[${i}]: start and end must be two different times 'HH:mm'` };
    }
    if (templates.some((template) => template.label === label)) {
      return { error: `shiftTemplates[${i}]: the label "${label}" is used twice` };
    }
    templates.push({ label, start, end });
  }
  return { templates };
}

/** Shifts: missing means none; each needs a user id and an end after its start, at most MAX_DUTY_SHIFT_DAYS later. Sorted by start. */
export function validateDutyShifts(raw: unknown): DutyShiftsResult {
  if (raw == null) return { shifts: [] };
  if (!Array.isArray(raw) || raw.length > MAX_DUTY_SHIFTS) {
    return { error: `shifts: a JSON array of at most ${MAX_DUTY_SHIFTS} shifts is required` };
  }
  const shifts: (DutyShift & { start: number })[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    if (!isRecord(entry) || !isRowId(entry.userId)) {
      return { error: `shifts[${i}]: a user id is required` };
    }
    const start = typeof entry.startsAt === "string" ? instantEpochMs(entry.startsAt) : null;
    const end = typeof entry.endsAt === "string" ? instantEpochMs(entry.endsAt) : null;
    if (start === null || end === null) {
      return { error: `shifts[${i}]: startsAt and endsAt must be instants with Z or an offset` };
    }
    if (end <= start || end - start > MAX_DUTY_SHIFT_DAYS * DAY_MS) {
      return {
        error: `shifts[${i}]: the end must be after the start, at most ${MAX_DUTY_SHIFT_DAYS} days later`,
      };
    }
    shifts.push({
      userId: entry.userId,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      start,
    });
  }
  shifts.sort((a, b) => a.start - b.start || a.userId - b.userId);
  return { shifts: shifts.map(({ userId, startsAt, endsAt }) => ({ userId, startsAt, endsAt })) };
}

/** The field code of refused templates for the form and the allowlist, or null. */
export function dutyTemplatesCode(raw: unknown): AuthoringFieldCode | null {
  if (!("error" in validateDutyTemplates(raw))) return null;
  if (
    Array.isArray(raw) &&
    raw.some(
      (t) => isRecord(t) && typeof t.label === "string" && t.label.trim().length > MAX_DUTY_LABEL,
    )
  ) {
    return "tooLong";
  }
  return "invalid";
}

/** The field code of refused shifts for the form and the allowlist, or null. */
export function dutyShiftsCode(raw: unknown): AuthoringFieldCode | null {
  const result = validateDutyShifts(raw);
  if (!("error" in result)) return null;
  return result.error.includes("end must be after") ? "endBeforeStart" : "invalid";
}

/** The shifts running at `at` (start ≤ at < end). */
export function dutyShiftsAt(shifts: readonly DutyShift[], at: Date): DutyShift[] {
  const ms = at.getTime();
  return shifts.filter((s) => Date.parse(s.startsAt) <= ms && ms < Date.parse(s.endsAt));
}

/** The shifts that overlap the half-open window [from, to). */
export function dutyShiftsBetween(shifts: readonly DutyShift[], from: Date, to: Date): DutyShift[] {
  return shifts.filter(
    (s) => Date.parse(s.startsAt) < to.getTime() && Date.parse(s.endsAt) > from.getTime(),
  );
}

/** Index pairs of shifts that run at the same time (allowed; the form shows a hint). */
export function dutyShiftOverlaps(shifts: readonly DutyShift[]): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < shifts.length; i++) {
    for (let j = i + 1; j < shifts.length; j++) {
      if (
        Date.parse(shifts[i].startsAt) < Date.parse(shifts[j].endsAt) &&
        Date.parse(shifts[j].startsAt) < Date.parse(shifts[i].endsAt)
      ) {
        pairs.push([i, j]);
      }
    }
  }
  return pairs;
}

/** A shift from a template on calendar day `day` in `timeZone`; an end at or before the start is the next day. */
export function dutyShiftFromTemplate(
  template: DutyShiftTemplate,
  day: string,
  userId: number,
  timeZone: string,
): DutyShift {
  const endDay = template.end <= template.start ? addDaysToKey(day, 1) : day;
  return {
    userId,
    startsAt: zonedWallTimeToInstant(day, template.start, timeZone).toISOString(),
    endsAt: zonedWallTimeToInstant(endDay, template.end, timeZone).toISOString(),
  };
}

/**
 * The same shift `days` calendar days later, at the same wall times (never
 * 24-hour steps: clock changes). A wall time the clock change skips or
 * repeats on the new day is refused, not guessed (#183, as every /manage
 * form): that endpoint stays the typed 'YYYY-MM-DDTHH:mm', which the editor
 * shows as typed and the save refuses with timeSkipped or timeRepeated.
 */
export function moveDutyShift(shift: DutyShift, days: number, timeZone: string): DutyShift {
  const move = (instant: string) => {
    const day = addDaysToKey(zonedDateKey(instant, timeZone), days);
    const time = zonedTimeOfDay(instant, timeZone);
    try {
      return zonedWallTimeToInstant(day, time, timeZone, "reject").toISOString();
    } catch (error) {
      if (isWallTimeError(error)) return `${day}T${time}`;
      throw error;
    }
  };
  return { userId: shift.userId, startsAt: move(shift.startsAt), endsAt: move(shift.endsAt) };
}

/**
 * Copies of the shifts starting in the week from `weekStart` (seven
 * calendar days), one week later. A shift still being typed (an endpoint
 * that is no instant) is not copied.
 */
export function copyDutyWeek(
  shifts: readonly DutyShift[],
  weekStart: string,
  timeZone: string,
): DutyShift[] {
  const weekEnd = addDaysToKey(weekStart, 7);
  return shifts
    .filter((s) => instantEpochMs(s.startsAt) !== null && instantEpochMs(s.endsAt) !== null)
    .filter((s) => {
      const day = zonedDateKey(s.startsAt, timeZone);
      return day >= weekStart && day < weekEnd;
    })
    .map((s) => moveDutyShift(s, 7, timeZone));
}

/**
 * The shifts without those that ended more than `keepDays` days before
 * `now`. A shift whose end is no instant stays, so the validation refuses
 * it instead of the prune dropping it unseen.
 */
export function pruneDutyShifts(
  shifts: readonly DutyShift[],
  now: Date,
  keepDays: number = DUTY_HISTORY_DAYS,
): DutyShift[] {
  const cutoff = now.getTime() - keepDays * DAY_MS;
  return shifts.filter((s) => {
    const end = instantEpochMs(s.endsAt);
    return end === null || end >= cutoff;
  });
}
