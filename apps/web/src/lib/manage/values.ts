/**
 * The values of the /manage forms (deep-dive decision 06 §L4; batch 15
 * plan, lane 15C): what the inputs hold, as plain strings, booleans and
 * lists, before any conversion. A form starts from emptyXValues() (create)
 * or xValuesFromEditable() (edit, from the cms's `editable` answer, K7) and
 * sends its values and the values it started from to the area's Server
 * Action, which converts and checks them (lib/manage/payload.ts).
 *
 * Server Action arguments come from the client, so the actions read them
 * through coerceXValues(): every field gets its type, a missing one its
 * empty value, and lists are capped, before anything else looks at them.
 * Pure; usable from server and client code.
 */
import {
  MAX_TARGET_DEPARTMENTS,
  MAX_POLL_OPTIONS,
  type AnnouncementEditable,
  type EventEditable,
  type PollEditable,
  type QuickLinkEditable,
} from "@sinnlos/domain";
import { normalizeGuestAccess } from "@/lib/poll-guest-access";
import { instantDay, splitInstant } from "./datetime";

export interface AnnouncementValues {
  title: string;
  /** Markdown. */
  body: string;
  pinned: boolean;
  expiresDate: string;
  expiresTime: string;
  /** A department's documentId, or "" for none. */
  department: string;
  /** A team's documentId, or "" for none. */
  team: string;
  /** Role types (`member`, `team_lead`, …). */
  audienceRoles: string[];
  requiresAck: boolean;
  /** `YYYY-MM-DD` or "". */
  ackDeadline: string;
}

export interface EventValues {
  title: string;
  /** Markdown. */
  description: string;
  allDay: boolean;
  startDate: string;
  /** Ignored for an all-day event. */
  startTime: string;
  /** All-day: the last day (inclusive). Timed: "" with an end time means the start's day. */
  endDate: string;
  endTime: string;
  location: string;
  url: string;
  rsvpEnabled: boolean;
  /** A positive integer as typed, or "" for no limit. */
  capacity: string;
  /** The departments to notify (documentIds). */
  departments: string[];
}

export interface QuickLinkValues {
  label: string;
  url: string;
  /** An ICON_KEYS name, or "" for none. */
  icon: string;
  category: string;
  /** 0..10000 as typed. */
  order: string;
  departments: string[];
}

export interface PollValues {
  question: string;
  options: string[];
  /** The closing day (`YYYY-MM-DD`, closes at 23:59:59 that day), or "". */
  closesDay: string;
  anonymous: boolean;
  departments: string[];
  visibleToGuests: boolean;
  guestsCanVote: boolean;
}

/** The schedule of the Schedule… dialog (moderators only, §D). */
export interface ScheduleValues {
  publishDate: string;
  publishTime: string;
  /** Quick links only. */
  unpublishDate: string;
  unpublishTime: string;
}

// ---------------------------------------------------------------------------
// Empty values (create)

export function emptyAnnouncementValues(department = ""): AnnouncementValues {
  return {
    title: "",
    body: "",
    pinned: false,
    expiresDate: "",
    expiresTime: "",
    department,
    team: "",
    audienceRoles: [],
    requiresAck: false,
    ackDeadline: "",
  };
}

export function emptyEventValues(departments: string[] = []): EventValues {
  return {
    title: "",
    description: "",
    allDay: false,
    startDate: "",
    startTime: "",
    endDate: "",
    endTime: "",
    location: "",
    url: "",
    rsvpEnabled: false,
    capacity: "",
    departments,
  };
}

export function emptyQuickLinkValues(): QuickLinkValues {
  return { label: "", url: "", icon: "", category: "tools", order: "0", departments: [] };
}

export function emptyPollValues(): PollValues {
  return {
    question: "",
    options: ["", ""],
    closesDay: "",
    anonymous: false,
    departments: [],
    visibleToGuests: false,
    guestsCanVote: false,
  };
}

export function emptyScheduleValues(): ScheduleValues {
  return { publishDate: "", publishTime: "", unpublishDate: "", unpublishTime: "" };
}

// ---------------------------------------------------------------------------
// From `editable` (edit)

export function announcementValuesFromEditable(
  editable: AnnouncementEditable,
  timeZone: string,
): AnnouncementValues {
  const expires = splitInstant(editable.expiresAt, timeZone);
  return {
    title: editable.title ?? "",
    body: editable.body ?? "",
    pinned: editable.pinned ?? false,
    expiresDate: expires.date,
    expiresTime: expires.time,
    department: editable.department ?? "",
    team: editable.team ?? "",
    audienceRoles: [...(editable.audienceRoles ?? [])],
    requiresAck: editable.requiresAck ?? false,
    ackDeadline: editable.ackDeadline ?? "",
  };
}

export function eventValuesFromEditable(editable: EventEditable, timeZone: string): EventValues {
  const start = splitInstant(editable.start, timeZone);
  const end = splitInstant(editable.end, timeZone);
  return {
    title: editable.title ?? "",
    description: editable.description ?? "",
    allDay: editable.allDay,
    startDate: start.date,
    startTime: editable.allDay ? "" : start.time,
    endDate: end.date,
    endTime: editable.allDay ? "" : end.time,
    location: editable.location ?? "",
    url: editable.url ?? "",
    rsvpEnabled: editable.rsvpEnabled,
    capacity: editable.capacity === null ? "" : String(editable.capacity),
    departments: [...(editable.departments ?? [])],
  };
}

export function quickLinkValuesFromEditable(editable: QuickLinkEditable): QuickLinkValues {
  return {
    label: editable.label ?? "",
    url: editable.url ?? "",
    icon: editable.icon ?? "",
    category: editable.category ?? "tools",
    order: String(editable.order ?? 0),
    departments: [...(editable.departments ?? [])],
  };
}

export function pollValuesFromEditable(editable: PollEditable, timeZone: string): PollValues {
  return {
    question: editable.question ?? "",
    options: [...(editable.options ?? [])],
    closesDay: instantDay(editable.closesAt, timeZone),
    anonymous: editable.anonymous,
    departments: [...(editable.departments ?? [])],
    ...normalizeGuestAccess(editable),
  };
}

export function scheduleValuesFromEditable(
  editable: { publishAt?: string | null; unpublishAt?: string | null },
  timeZone: string,
): ScheduleValues {
  const publish = splitInstant(editable.publishAt, timeZone);
  const unpublish = splitInstant(editable.unpublishAt, timeZone);
  return {
    publishDate: publish.date,
    publishTime: publish.time,
    unpublishDate: unpublish.date,
    unpublishTime: unpublish.time,
  };
}

// ---------------------------------------------------------------------------
// Coercion of Server Action arguments

/** Longest single text the actions accept before their own checks (Markdown max + slack). */
const MAX_TEXT = 210_000;
/** Most entries a list argument keeps. */
const MAX_LIST = Math.max(MAX_TARGET_DEPARTMENTS, MAX_POLL_OPTIONS) + 10;

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string => (typeof value === "string" ? value.slice(0, MAX_TEXT) : "");

const bool = (value: unknown): boolean => value === true;

const strList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_LIST)
    : [];

/** A list of ids: trimmed, non-empty, unique, in the order given. */
const idList = (value: unknown): string[] => [
  ...new Set(
    strList(value)
      .map((entry) => entry.trim())
      .filter(Boolean),
  ),
];

export function coerceAnnouncementValues(raw: unknown): AnnouncementValues {
  const r = isRecord(raw) ? raw : {};
  return {
    title: str(r.title),
    body: str(r.body),
    pinned: bool(r.pinned),
    expiresDate: str(r.expiresDate),
    expiresTime: str(r.expiresTime),
    department: str(r.department).trim(),
    team: str(r.team).trim(),
    audienceRoles: idList(r.audienceRoles),
    requiresAck: bool(r.requiresAck),
    ackDeadline: str(r.ackDeadline),
  };
}

export function coerceEventValues(raw: unknown): EventValues {
  const r = isRecord(raw) ? raw : {};
  return {
    title: str(r.title),
    description: str(r.description),
    allDay: bool(r.allDay),
    startDate: str(r.startDate),
    startTime: str(r.startTime),
    endDate: str(r.endDate),
    endTime: str(r.endTime),
    location: str(r.location),
    url: str(r.url),
    rsvpEnabled: bool(r.rsvpEnabled),
    capacity: str(r.capacity),
    departments: idList(r.departments),
  };
}

export function coerceQuickLinkValues(raw: unknown): QuickLinkValues {
  const r = isRecord(raw) ? raw : {};
  return {
    label: str(r.label),
    url: str(r.url),
    icon: str(r.icon).trim(),
    category: str(r.category).trim(),
    order: str(r.order),
    departments: idList(r.departments),
  };
}

export function coercePollValues(raw: unknown): PollValues {
  const r = isRecord(raw) ? raw : {};
  return {
    question: str(r.question),
    // Options keep their order and blanks: votes point at an index, and a
    // blank answer is refused (`required`), never dropped.
    options: strList(r.options),
    closesDay: str(r.closesDay),
    anonymous: bool(r.anonymous),
    departments: idList(r.departments),
    ...normalizeGuestAccess({
      visibleToGuests: bool(r.visibleToGuests),
      guestsCanVote: bool(r.guestsCanVote),
    }),
  };
}

export function coerceScheduleValues(raw: unknown): ScheduleValues {
  const r = isRecord(raw) ? raw : {};
  return {
    publishDate: str(r.publishDate),
    publishTime: str(r.publishTime),
    unpublishDate: str(r.unpublishDate),
    unpublishTime: str(r.unpublishTime),
  };
}
