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
  MAX_DUTY_SHIFTS,
  MAX_DUTY_TEMPLATES,
  MAX_KPI_VALUES,
  isKpiAggregation,
  isKpiPeriod,
  type KpiAggregation,
  type KpiEditable,
  type KpiPeriod,
  type AnnouncementEditable,
  type DocumentEditable,
  type DutyPlanEditable,
  type DutyShift,
  type DutyShiftTemplate,
  type EditableMedia,
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

export interface DocumentValues {
  title: string;
  /** Plain text (the library shows it as written). */
  description: string;
  category: string;
  /** The departments that see it (documentIds); none: everyone. */
  departments: string[];
  /**
   * The file the document links: the stored one (from `editable`), one the
   * form uploaded for this save (lib/manage/upload.ts), or none. Only its
   * `id` is sent; the rest is for the form's display.
   */
  file: EditableMedia | null;
}

/**
 * A duty plan (v0.18): the department (documentId, "" for the whole
 * company), the shift templates and the shifts as the cms stores them;
 * the form edits a shift's day and times and writes the instants back.
 */
export interface DutyPlanValues {
  name: string;
  note: string;
  department: string;
  shiftTemplates: DutyShiftTemplate[];
  shifts: DutyShift[];
}

/**
 * A KPI (v0.19): the department (documentId, "" for the whole company) and
 * the values as typed, by period start; a blank entry is no value. Entries
 * outside the table's window stay as stored.
 */
export interface KpiValues {
  name: string;
  unit: string;
  description: string;
  department: string;
  period: KpiPeriod;
  aggregation: KpiAggregation;
  values: Record<string, string>;
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

export function emptyDocumentValues(departments: string[] = []): DocumentValues {
  return { title: "", description: "", category: "other", departments, file: null };
}

export function emptyDutyPlanValues(department = ""): DutyPlanValues {
  return { name: "", note: "", department, shiftTemplates: [], shifts: [] };
}

export function dutyPlanValuesFromEditable(editable: DutyPlanEditable): DutyPlanValues {
  return {
    name: editable.name ?? "",
    note: editable.note ?? "",
    department: editable.department ?? "",
    shiftTemplates: (editable.shiftTemplates ?? []).map((template) => ({ ...template })),
    shifts: (editable.shifts ?? []).map((shift) => ({ ...shift })),
  };
}

export function emptyKpiValues(department = ""): KpiValues {
  return {
    name: "",
    unit: "",
    description: "",
    department,
    period: "month",
    aggregation: "sum",
    values: {},
  };
}

export function kpiValuesFromEditable(editable: KpiEditable): KpiValues {
  return {
    name: editable.name ?? "",
    unit: editable.unit ?? "",
    description: editable.description ?? "",
    department: editable.department ?? "",
    period: editable.period,
    aggregation: editable.aggregation,
    values: Object.fromEntries(
      Object.entries(editable.values ?? {}).map(([period, value]) => [period, String(value)]),
    ),
  };
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

export function documentValuesFromEditable(editable: DocumentEditable): DocumentValues {
  return {
    title: editable.title ?? "",
    description: editable.description ?? "",
    category: editable.category ?? "other",
    departments: [...(editable.departments ?? [])],
    file: editable.file ? { ...editable.file } : null,
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
export const idList = (value: unknown): string[] => [
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

/** A file value from the client: a positive integer id (the rest is display only), or null. */
function fileValue(value: unknown): EditableMedia | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
  return {
    id,
    name: str(value.name),
    mime: str(value.mime),
    size: typeof value.size === "number" && Number.isFinite(value.size) ? value.size : 0,
    url: str(value.url),
  };
}

export function coerceDocumentValues(raw: unknown): DocumentValues {
  const r = isRecord(raw) ? raw : {};
  return {
    title: str(r.title),
    description: str(r.description),
    category: str(r.category).trim(),
    departments: idList(r.departments),
    file: fileValue(r.file),
  };
}

/**
 * Templates and shifts as the client sent them: entries of the right shape.
 * The lists are capped one above their limit, so an overlong list reaches
 * the payload rules and is refused there, never cut down unseen.
 */
export function coerceDutyPlanValues(raw: unknown): DutyPlanValues {
  const r = isRecord(raw) ? raw : {};
  const list = (value: unknown, max: number) =>
    (Array.isArray(value) ? value : []).filter(isRecord).slice(0, max);
  return {
    name: str(r.name),
    note: str(r.note),
    department: str(r.department).trim(),
    shiftTemplates: list(r.shiftTemplates, MAX_DUTY_TEMPLATES + 1).map((t) => ({
      label: str(t.label),
      start: str(t.start),
      end: str(t.end),
    })),
    shifts: list(r.shifts, MAX_DUTY_SHIFTS + 1).map((s) => ({
      userId: typeof s.userId === "number" ? s.userId : 0,
      startsAt: str(s.startsAt),
      endsAt: str(s.endsAt),
    })),
  };
}

/**
 * The values as the client sent them: string entries only, capped one
 * above the limit, so an overlong set is refused by the payload rules.
 */
export function coerceKpiValues(raw: unknown): KpiValues {
  const r = isRecord(raw) ? raw : {};
  const values = isRecord(r.values) ? r.values : {};
  return {
    name: str(r.name),
    unit: str(r.unit),
    description: str(r.description),
    department: str(r.department).trim(),
    period: isKpiPeriod(r.period) ? r.period : "month",
    aggregation: isKpiAggregation(r.aggregation) ? r.aggregation : "sum",
    values: Object.fromEntries(
      Object.entries(values)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .slice(0, MAX_KPI_VALUES + 1),
    ),
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
