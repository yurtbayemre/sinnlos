/**
 * The payload builders of the /manage actions (deep-dive decision 06 §L3
 * steps 2-4, §L4, §B1; batch 15 plan, lane 15C item 3). From a form's
 * values (lib/manage/values.ts) they run the shared @sinnlos/domain checks
 * (K7 validators) for precise messages, convert the dates (reject mode,
 * lib/manage/datetime.ts) and build the `data` of the write. The cms
 * allowlist is authoritative and answers the same codes (details.codes);
 * these checks only spare the author a round trip.
 *
 * Which keys a payload carries:
 *   - only the keys of the caller's class (AUTHORING_FIELDS[type][class]):
 *     a department author never sends pinned, requiresAck, ackDeadline or a
 *     schedule (§N2), whatever the form held;
 *   - a create carries every field; an update only the fields whose inputs
 *     changed against the values the form started from, so an untouched
 *     legacy value is never re-validated or rewritten;
 *   - the targeting keys (TARGETING_KEYS) only when the targeting changed,
 *     or when the author re-targets explicitly (`retarget`): a targeting key
 *     re-derives the item's targeting flags and lowers the announcement's
 *     retargetRequired marker (§B1.2 "targeting flags never widen
 *     implicitly", §N9). Then all of the type's targeting keys go together;
 *   - a department author's targeting is pinned (§N4): announcement
 *     `department` = their department, event `departments` = [it]. A
 *     create always sends it;
 *   - an item that needs re-targeting (`needsRetarget`) is never made
 *     company-wide by accident: targeting that would reach everyone (an
 *     announcement without department and team, an empty `departments`)
 *     is refused with `confirmAudience` unless the author confirmed the
 *     audience (`retarget`). The save path asks the cms whether the item
 *     needs re-targeting before such a write (lib/manage/save.ts).
 * Pure: `now` and the zone come from the caller.
 */
import {
  AUTHORING_FIELDS,
  DOCUMENT_CATEGORIES,
  QUICK_LINK_CATEGORIES,
  MAX_POLL_OPTION_LENGTH,
  TARGETING_KEYS,
  checkEnum,
  checkIconKey,
  checkMarkdown,
  checkNullableString,
  checkNullableWebUrl,
  checkOrder,
  checkPositiveIntOrNull,
  checkQuickLinkUrl,
  checkRequiredString,
  eventSpanCode,
  pollOptionsCode,
  samePollOptions,
  scheduleCodes,
  type AuthoringRoleClass,
  type AuthoringType,
  type FieldCheck,
} from "@sinnlos/domain";
import { pollClosesAtForDay } from "@/lib/poll-close";
import {
  dayStartInstant,
  plainDateValue,
  requiredWallTimeInstant,
  wallTimeInstant,
  type Converted,
} from "./datetime";
import type { ManageErrorCode } from "./errors";
import type {
  AnnouncementValues,
  DocumentValues,
  EventValues,
  PollValues,
  QuickLinkValues,
  ScheduleValues,
} from "./values";

export interface PayloadContext {
  mode: "create" | "update";
  roleClass: AuthoringRoleClass;
  timeZone: string;
  /** Epoch ms of "now" (the schedule's one-minute lead). */
  now: number;
  /** A department author's own department (documentId): the pinned targeting. */
  ownDepartment: string | null;
  /** Send the targeting keys although they did not change (an explicit re-target). */
  retarget?: boolean;
  /**
   * The item needs re-targeting (the cms's `needsRetarget`): targeting that
   * would reach everyone is refused unless `retarget` confirms it.
   */
  needsRetarget?: boolean;
}

export type BuiltPayload =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; fields: Record<string, ManageErrorCode> };

/**
 * One payload key: the inputs it reads and how it is converted. `C` is the
 * context the conversion reads (PayloadContext for the K7 types; the wiki
 * builders bring their own, lib/manage/wiki-payload.ts).
 */
export interface FieldRule<V extends object, C = PayloadContext> {
  key: string;
  inputs: readonly (keyof V)[];
  /** The inputs the field reads for these values, when that depends on them (default `inputs`). */
  inputsOf?: (values: V) => readonly (keyof V)[];
  convert(values: V, ctx: C): Converted<unknown>;
  /** Whether two values of one input are the same (default: scalars, lists as sets). */
  same?: (a: unknown, b: unknown) => boolean;
}

/** Lists of ids are sets: a different order is no change. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const left = [...a].map(String).sort();
    const right = [...b].map(String).sort();
    return left.every((value, i) => value === right[i]);
  }
  return a === b;
}

/** A converted field from a domain check of the value as it is. */
export function checked(value: unknown, check: FieldCheck): Converted<unknown> {
  const code = check(value);
  return code ? { code } : { value };
}

/** Trimmed text, or null when blank. */
export const textOrNull = (value: string): string | null =>
  value.trim() === "" ? null : value.trim();

/**
 * The payload keys of `rules` that `allowed` admits and that changed
 * against `initial` (every one on a create), converted; the `targeting`
 * keys travel together, when one of them changed or `retarget` asks for
 * them (see the header). Refused conversions land in `fields`.
 */
export function collectFields<V extends object, C>(
  allowed: ReadonlySet<string>,
  targeting: ReadonlySet<string>,
  rules: readonly FieldRule<V, C>[],
  values: V,
  initial: V | null,
  ctx: C & { mode: "create" | "update"; retarget?: boolean },
): { data: Record<string, unknown>; fields: Record<string, ManageErrorCode> } {
  const base = ctx.mode === "create" ? null : initial;
  const changed = (rule: FieldRule<V, C>) =>
    base === null ||
    (rule.inputsOf?.(values) ?? rule.inputs).some(
      (input) => !(rule.same ?? sameValue)(values[input], base[input]),
    );
  const targetingChanged =
    ctx.retarget === true || rules.some((rule) => targeting.has(rule.key) && changed(rule));

  const data: Record<string, unknown> = {};
  const fields: Record<string, ManageErrorCode> = {};
  for (const rule of rules) {
    if (!allowed.has(rule.key)) continue;
    const send = targeting.has(rule.key) ? targetingChanged : changed(rule);
    if (!send) continue;
    const converted = rule.convert(values, ctx);
    if ("code" in converted) fields[rule.key] = converted.code;
    else data[rule.key] = converted.value;
  }
  return { data, fields };
}

function buildFields<V extends object>(
  type: AuthoringType,
  rules: readonly FieldRule<V>[],
  values: V,
  initial: V | null,
  ctx: PayloadContext,
): { data: Record<string, unknown>; fields: Record<string, ManageErrorCode> } {
  const { data, fields } = collectFields(
    new Set(AUTHORING_FIELDS[type][ctx.roleClass] ?? []),
    new Set(TARGETING_KEYS[type]),
    rules,
    values,
    initial,
    ctx,
  );
  if (ctx.needsRetarget === true && ctx.retarget !== true && widensToEveryone(type, data)) {
    fields[TARGETING_KEYS[type][0]] = "confirmAudience";
  }
  return { data, fields };
}

/**
 * Whether `data` sets the targeting of `type` to "everyone": an
 * announcement without department and team (roles alone reach a role
 * across the company), an empty `departments` list. A payload without the
 * targeting keys changes nothing and widens nothing.
 */
export function widensToEveryone(type: AuthoringType, data: Record<string, unknown>): boolean {
  if (type === "announcement") {
    return "department" in data && data.department == null && data.team == null;
  }
  return Array.isArray(data.departments) && data.departments.length === 0;
}

export const done = (
  data: Record<string, unknown>,
  fields: Record<string, ManageErrorCode>,
): BuiltPayload => (Object.keys(fields).length > 0 ? { ok: false, fields } : { ok: true, data });

// ---------------------------------------------------------------------------
// Announcement

const ANNOUNCEMENT_RULES: readonly FieldRule<AnnouncementValues>[] = [
  {
    key: "title",
    inputs: ["title"],
    convert: (v) => checked(v.title.trim(), checkRequiredString),
  },
  {
    key: "body",
    inputs: ["body"],
    convert: (v) => checked(v.body.trim() === "" ? null : v.body, checkMarkdown),
  },
  { key: "pinned", inputs: ["pinned"], convert: (v) => ({ value: v.pinned }) },
  {
    key: "expiresAt",
    inputs: ["expiresDate", "expiresTime"],
    convert: (v, ctx) => wallTimeInstant(v.expiresDate, v.expiresTime, ctx.timeZone),
  },
  {
    key: "department",
    inputs: ["department"],
    // A department author's announcement is pinned to their department.
    convert: (v, ctx) => ({
      value: ctx.roleClass === "departmentAuthor" ? ctx.ownDepartment : textOrNull(v.department),
    }),
  },
  { key: "team", inputs: ["team"], convert: (v) => ({ value: textOrNull(v.team) }) },
  {
    key: "audienceRoles",
    inputs: ["audienceRoles"],
    convert: (v) => ({ value: [...v.audienceRoles] }),
  },
  { key: "requiresAck", inputs: ["requiresAck"], convert: (v) => ({ value: v.requiresAck }) },
  {
    key: "ackDeadline",
    inputs: ["ackDeadline", "requiresAck"],
    convert: (v) => plainDateValue(v.ackDeadline),
  },
];

export function buildAnnouncementPayload(
  values: AnnouncementValues,
  initial: AnnouncementValues | null,
  ctx: PayloadContext,
): BuiltPayload {
  const { data, fields } = buildFields("announcement", ANNOUNCEMENT_RULES, values, initial, ctx);
  // A deadline needs the confirmation (the cms crossCheck, early).
  if (
    "ackDeadline" in data &&
    data.ackDeadline !== null &&
    !values.requiresAck &&
    !fields.ackDeadline
  ) {
    fields.ackDeadline = "ackDeadlineWithoutAck";
  }
  return done(data, fields);
}

// ---------------------------------------------------------------------------
// Event

/** An event's start: the first instant of its day (all-day), or the typed time. */
function eventStart(v: EventValues, ctx: PayloadContext): Converted<unknown> {
  return v.allDay
    ? dayStartInstant(v.startDate, ctx.timeZone, { required: true })
    : requiredWallTimeInstant(v.startDate, v.startTime, ctx.timeZone);
}

/**
 * An event's end: the first instant of its last day (all-day; none for a
 * one-day event), or the typed time, on the start's day when only a time
 * is given.
 */
function eventEnd(v: EventValues, ctx: PayloadContext): Converted<unknown> {
  return v.allDay
    ? dayStartInstant(v.endDate, ctx.timeZone)
    : wallTimeInstant(v.endDate, v.endTime, ctx.timeZone, { fallbackDate: v.startDate });
}

const EVENT_RULES: readonly FieldRule<EventValues>[] = [
  { key: "title", inputs: ["title"], convert: (v) => checked(v.title.trim(), checkRequiredString) },
  {
    key: "description",
    inputs: ["description"],
    convert: (v) => checked(v.description.trim() === "" ? null : v.description, checkMarkdown),
  },
  { key: "allDay", inputs: ["allDay"], convert: (v) => ({ value: v.allDay }) },
  { key: "start", inputs: ["allDay", "startDate", "startTime"], convert: eventStart },
  {
    key: "end",
    inputs: ["allDay", "startDate", "endDate", "endTime"],
    // The start's day matters only to an end given as a time alone: a
    // moved start leaves an explicit end alone (changed fields only).
    inputsOf: (v) =>
      !v.allDay && v.endDate.trim() === ""
        ? ["allDay", "startDate", "endDate", "endTime"]
        : ["allDay", "endDate", "endTime"],
    convert: eventEnd,
  },
  {
    key: "location",
    inputs: ["location"],
    convert: (v) => checked(textOrNull(v.location), checkNullableString),
  },
  { key: "url", inputs: ["url"], convert: (v) => checked(textOrNull(v.url), checkNullableWebUrl) },
  { key: "rsvpEnabled", inputs: ["rsvpEnabled"], convert: (v) => ({ value: v.rsvpEnabled }) },
  {
    key: "capacity",
    inputs: ["capacity"],
    convert: (v) => {
      const typed = v.capacity.trim();
      if (typed === "") return { value: null };
      if (!/^\d{1,10}$/.test(typed)) return { code: "invalid" };
      return checked(Number(typed), checkPositiveIntOrNull);
    },
  },
  {
    key: "departments",
    inputs: ["departments"],
    // A department author's event notifies their department, pinned.
    convert: (v, ctx) => ({
      value:
        ctx.roleClass === "departmentAuthor"
          ? ctx.ownDepartment
            ? [ctx.ownDepartment]
            : []
          : [...v.departments],
    }),
  },
];

export function buildEventPayload(
  values: EventValues,
  initial: EventValues | null,
  ctx: PayloadContext,
): BuiltPayload {
  const { data, fields } = buildFields("event", EVENT_RULES, values, initial, ctx);
  // End before start (the cms crossCheck, early), when the payload moves one
  // of them and both convert.
  if (("start" in data || "end" in data) && !fields.start && !fields.end) {
    const start = eventStart(values, ctx);
    const end = eventEnd(values, ctx);
    if ("value" in start && "value" in end) {
      const code = eventSpanCode(start.value, end.value);
      if (code) fields.end = code;
    }
  }
  return done(data, fields);
}

// ---------------------------------------------------------------------------
// Quick link

const QUICK_LINK_RULES: readonly FieldRule<QuickLinkValues>[] = [
  { key: "label", inputs: ["label"], convert: (v) => checked(v.label.trim(), checkRequiredString) },
  { key: "url", inputs: ["url"], convert: (v) => checked(v.url.trim(), checkQuickLinkUrl) },
  { key: "icon", inputs: ["icon"], convert: (v) => checked(textOrNull(v.icon), checkIconKey) },
  {
    key: "category",
    inputs: ["category"],
    convert: (v) => checked(v.category, checkEnum(QUICK_LINK_CATEGORIES)),
  },
  {
    key: "order",
    inputs: ["order"],
    convert: (v) => {
      const typed = v.order.trim() === "" ? "0" : v.order.trim();
      return /^\d{1,6}$/.test(typed) ? checked(Number(typed), checkOrder) : { code: "invalid" };
    },
  },
  { key: "departments", inputs: ["departments"], convert: (v) => ({ value: [...v.departments] }) },
];

export function buildQuickLinkPayload(
  values: QuickLinkValues,
  initial: QuickLinkValues | null,
  ctx: PayloadContext,
): BuiltPayload {
  const { data, fields } = buildFields("quickLink", QUICK_LINK_RULES, values, initial, ctx);
  return done(data, fields);
}

// ---------------------------------------------------------------------------
// Document

/** The id of a file value (null without a file). */
const fileId = (file: unknown): number | null => (file as DocumentValues["file"])?.id ?? null;

const DOCUMENT_RULES: readonly FieldRule<DocumentValues>[] = [
  { key: "title", inputs: ["title"], convert: (v) => checked(v.title.trim(), checkRequiredString) },
  {
    key: "description",
    inputs: ["description"],
    convert: (v) => checked(v.description.trim() === "" ? null : v.description, checkMarkdown),
  },
  {
    key: "category",
    inputs: ["category"],
    convert: (v) => checked(v.category, checkEnum(DOCUMENT_CATEGORIES)),
  },
  {
    key: "departments",
    inputs: ["departments"],
    // A department author's document is for their department, pinned (§N4).
    convert: (v, ctx) => ({
      value:
        ctx.roleClass === "departmentAuthor"
          ? ctx.ownDepartment
            ? [ctx.ownDepartment]
            : []
          : [...v.departments],
    }),
  },
  {
    key: "file",
    inputs: ["file"],
    // The file row id (§E6): a new upload attaches it, the stored id keeps
    // it. Only a different id is a change, so an untouched file (another
    // author's, a legacy one) is never sent again.
    same: (a, b) => fileId(a) === fileId(b),
    convert: (v) => ({ value: fileId(v.file) }),
  },
];

/**
 * A document's payload. The file is a row id from POST /api/upload
 * (lib/manage/upload.ts), uploaded before the save; the cms checks that a
 * newly attached file is the caller's own fresh upload (§E2, the media
 * claims of §E3). A create without a file sends `file: null`.
 */
export function buildDocumentPayload(
  values: DocumentValues,
  initial: DocumentValues | null,
  ctx: PayloadContext,
): BuiltPayload {
  const { data, fields } = buildFields("document", DOCUMENT_RULES, values, initial, ctx);
  return done(data, fields);
}

// ---------------------------------------------------------------------------
// Poll

const POLL_RULES: readonly FieldRule<PollValues>[] = [
  {
    key: "question",
    inputs: ["question"],
    convert: (v) => checked(v.question.trim(), checkRequiredString),
  },
  {
    key: "options",
    inputs: ["options"],
    // Votes point at an index: the order counts, and nothing is dropped.
    same: samePollOptions,
    convert: (v) => {
      const code = pollOptionsCode(v.options, { maxLength: MAX_POLL_OPTION_LENGTH });
      return code ? { code } : { value: v.options.map((option) => option.trim()) };
    },
  },
  {
    key: "closesAt",
    inputs: ["closesDay"],
    // "Closes on D" = D 23:59:59 in APP_TIME_ZONE (the poll close rule).
    convert: (v, ctx) => {
      const day = v.closesDay.trim();
      if (day === "") return { value: null };
      const closesAt = pollClosesAtForDay(day, ctx.timeZone);
      return closesAt ? { value: closesAt } : { code: "invalidDate" };
    },
  },
  { key: "anonymous", inputs: ["anonymous"], convert: (v) => ({ value: v.anonymous }) },
  { key: "departments", inputs: ["departments"], convert: (v) => ({ value: [...v.departments] }) },
  {
    key: "visibleToGuests",
    inputs: ["visibleToGuests"],
    convert: (v) => ({ value: v.visibleToGuests }),
  },
  {
    key: "guestsCanVote",
    inputs: ["visibleToGuests", "guestsCanVote"],
    convert: (v) => ({ value: v.visibleToGuests && v.guestsCanVote }),
  },
];

/**
 * `hasVotes`: the poll's options and anonymity are frozen (frozenAfterVotes,
 * §B1.2), so they are never sent, whatever the form held.
 */
export function buildPollPayload(
  values: PollValues,
  initial: PollValues | null,
  ctx: PayloadContext & { hasVotes?: boolean },
): BuiltPayload {
  const rules = ctx.hasVotes
    ? POLL_RULES.filter((rule) => rule.key !== "options" && rule.key !== "anonymous")
    : POLL_RULES;
  const { data, fields } = buildFields("poll", rules, values, initial, ctx);
  return done(data, fields);
}

// ---------------------------------------------------------------------------
// Schedule (moderators, §D)

/**
 * `publishAt` (and, for quick links, `unpublishAt`) from the Schedule…
 * dialog: wall times in reject mode, then the schedule checks of §D rule 3
 * (at least a minute ahead, the end after the start, an announcement's
 * expiry after the publish). Only the keys the type and class allow.
 */
export function buildSchedulePayload(
  type: AuthoringType,
  schedule: ScheduleValues,
  ctx: PayloadContext,
  { expiresAt }: { expiresAt?: string | null } = {},
): BuiltPayload {
  const allowed = new Set(AUTHORING_FIELDS[type][ctx.roleClass] ?? []);
  const data: Record<string, unknown> = {};
  const fields: Record<string, ManageErrorCode> = {};
  if (allowed.has("publishAt")) {
    const publishAt = wallTimeInstant(schedule.publishDate, schedule.publishTime, ctx.timeZone);
    if ("code" in publishAt) fields.publishAt = publishAt.code;
    else data.publishAt = publishAt.value;
  }
  if (allowed.has("unpublishAt")) {
    const unpublishAt = wallTimeInstant(
      schedule.unpublishDate,
      schedule.unpublishTime,
      ctx.timeZone,
    );
    if ("code" in unpublishAt) fields.unpublishAt = unpublishAt.code;
    else data.unpublishAt = unpublishAt.value;
  }
  if (Object.keys(fields).length === 0) {
    const codes = scheduleCodes(
      { publishAt: data.publishAt, unpublishAt: data.unpublishAt, expiresAt },
      ctx.now,
    );
    for (const [key, code] of Object.entries(codes)) {
      // expiresBeforePublish is about the schedule the author just typed.
      fields[key === "expiresAt" ? "publishAt" : key] = code;
    }
  }
  return done(data, fields);
}
