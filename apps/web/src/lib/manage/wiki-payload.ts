/**
 * The payload builders of the wiki forms (deep-dive decision 06 §J1, §J2,
 * §L3; batch 16 plan, lane 16C items 4 and 5; contract K18): from a form's
 * values (lib/manage/wiki-values.ts) the domain checks for precise
 * messages, then the `data` of the write. The cms allowlist is
 * authoritative and answers the same codes; these checks only spare the
 * author a round trip. The rules of lib/manage/payload.ts hold here too:
 *   - only the keys of the caller's class (@sinnlos/domain WIKI_FIELDS):
 *     an author never sends department, team or publishAt, a space's
 *     update never its slug, a page's update never its space;
 *   - a create carries every field, an update only what changed against
 *     the values the form started from;
 *   - a space's visibility travels with its target as one targeting
 *     group: visibility, allowedRoles, department and team together, the
 *     ones the visibility does not use cleared, so the cms checks the pair
 *     (`visibilityTarget`) and no stale target is left behind; a space
 *     that needs re-targeting is never made public without the author's
 *     confirmation (`confirmAudience`, like the K7 types).
 * Pure: `now` and the zone come from the caller.
 */
import {
  MAX_STRING_LENGTH,
  WIKI_FIELDS,
  WIKI_SPACE_VISIBILITIES,
  checkEnum,
  checkIconKey,
  checkMarkdown,
  checkOrder,
  checkRequiredString,
  scheduleCodes,
  type WikiEditorClass,
} from "@sinnlos/domain";
import { MAX_WIKI_TAG_LENGTH, MAX_WIKI_TAGS } from "@/lib/wiki-content";
import { wallTimeInstant, type Converted } from "./datetime";
import type { ManageErrorCode } from "./errors";
import {
  checked,
  collectFields,
  done,
  sameValue,
  textOrNull,
  type BuiltPayload,
  type FieldRule,
} from "./payload";
import type { ScheduleValues } from "./values";
import type { WikiPageValues, WikiSpaceValues } from "./wiki-values";

// ---------------------------------------------------------------------------
// Spaces (moderators)

export interface WikiSpacePayloadContext {
  mode: "create" | "update";
  /** Send the targeting group although it did not change (an explicit re-target). */
  retarget?: boolean;
  /** The space's target is gone (the cms's `needsRetarget`): public needs the confirmation. */
  needsRetarget?: boolean;
}

/** The visibility, and with it its target, as one group (see the header). */
const SPACE_TARGETING = new Set(["visibility", "allowedRoles", "department", "team"]);

const SPACE_RULES: readonly FieldRule<WikiSpaceValues, WikiSpacePayloadContext>[] = [
  { key: "name", inputs: ["name"], convert: (v) => checked(v.name.trim(), checkRequiredString) },
  { key: "icon", inputs: ["icon"], convert: (v) => checked(textOrNull(v.icon), checkIconKey) },
  {
    key: "description",
    inputs: ["description"],
    convert: (v) => checked(v.description.trim() === "" ? null : v.description, checkMarkdown),
  },
  {
    key: "visibility",
    inputs: ["visibility"],
    convert: (v) => checked(v.visibility, checkEnum(WIKI_SPACE_VISIBILITIES)),
  },
  {
    key: "allowedRoles",
    inputs: ["allowedRoles"],
    convert: (v) => ({ value: v.visibility === "role" ? [...v.allowedRoles] : [] }),
  },
  {
    key: "department",
    inputs: ["department"],
    convert: (v) => ({ value: v.visibility === "department" ? textOrNull(v.department) : null }),
  },
  {
    key: "team",
    inputs: ["team"],
    convert: (v) => ({ value: v.visibility === "team" ? textOrNull(v.team) : null }),
  },
];

/** The key a visibility's target lives in. */
const TARGET_KEY: Readonly<Record<string, "allowedRoles" | "department" | "team">> = {
  role: "allowedRoles",
  department: "department",
  team: "team",
};

export function buildWikiSpacePayload(
  values: WikiSpaceValues,
  initial: WikiSpaceValues | null,
  ctx: WikiSpacePayloadContext,
): BuiltPayload {
  const { data, fields } = collectFields<WikiSpaceValues, WikiSpacePayloadContext>(
    new Set(WIKI_FIELDS.wikiSpace[ctx.mode].moderator),
    SPACE_TARGETING,
    SPACE_RULES,
    values,
    initial,
    ctx,
  );
  // The visibility needs its target (the cms crossCheck, early).
  const target = TARGET_KEY[String(data.visibility)];
  if (target && !fields.visibility) {
    const value = data[target];
    if (value === null || (Array.isArray(value) && value.length === 0)) {
      fields[target] = "visibilityTarget";
    }
  }
  if (
    ctx.needsRetarget === true &&
    ctx.retarget !== true &&
    data.visibility === "public" &&
    !fields.visibility
  ) {
    fields.visibility = "confirmAudience";
  }
  return done(data, fields);
}

// ---------------------------------------------------------------------------
// Pages

export interface WikiPagePayloadContext {
  mode: "create" | "update";
  /**
   * The class whose keys the payload carries: moderators, or the page's row
   * classes (the same keys for author, departmentHead and teamLead; on a
   * create a department head or team lead writes as `author`).
   */
  roleClass: WikiEditorClass;
  /** The space of a create (its documentId); the page's own on an update. */
  space: string | null;
  timeZone: string;
  /** Epoch ms of "now" (the schedule's one-minute lead). */
  now: number;
}

/** The tags as the payload sends them: trimmed, without blanks and case-insensitive repeats. */
export function parseWikiTags(text: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of text.split(",")) {
    const tag = part.trim();
    const key = tag.toLocaleLowerCase();
    if (tag === "" || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function tagsField(text: string): Converted<unknown> {
  const tags = parseWikiTags(text);
  if (tags.length > MAX_WIKI_TAGS) return { code: "invalid" };
  if (tags.some((tag) => tag.length > MAX_WIKI_TAG_LENGTH)) return { code: "tooLong" };
  return { value: tags };
}

function orderField(text: string): Converted<unknown> {
  const typed = text.trim() === "" ? "0" : text.trim();
  return /^\d{1,6}$/.test(typed) ? checked(Number(typed), checkOrder) : { code: "invalid" };
}

const PAGE_RULES: readonly FieldRule<WikiPageValues, WikiPagePayloadContext>[] = [
  { key: "title", inputs: ["title"], convert: (v) => checked(v.title.trim(), checkRequiredString) },
  {
    key: "summary",
    inputs: ["summary"],
    convert: (v) => checked(v.summary.trim() === "" ? null : v.summary.trim(), checkMarkdown),
  },
  {
    key: "body",
    inputs: ["body"],
    convert: (v) => checked(v.body.trim() === "" ? null : v.body, checkMarkdown),
  },
  {
    key: "tags",
    inputs: ["tags"],
    same: (a, b) => sameValue(parseWikiTags(String(a)), parseWikiTags(String(b))),
    convert: (v) => tagsField(v.tags),
  },
  { key: "tocEnabled", inputs: ["tocEnabled"], convert: (v) => ({ value: v.tocEnabled }) },
  { key: "order", inputs: ["order"], convert: (v) => orderField(v.order) },
  {
    key: "space",
    // Not an input: the space of a create comes from the page it was opened in.
    inputs: [],
    convert: (_v, ctx) => (ctx.space ? { value: ctx.space } : { code: "required" }),
  },
  { key: "parent", inputs: ["parent"], convert: (v) => ({ value: textOrNull(v.parent) }) },
  {
    key: "department",
    inputs: ["department"],
    convert: (v) => ({ value: textOrNull(v.department) }),
  },
  { key: "team", inputs: ["team"], convert: (v) => ({ value: textOrNull(v.team) }) },
  {
    key: "revisionSummary",
    inputs: ["revisionSummary"],
    convert: (v) =>
      v.revisionSummary.trim().length > MAX_STRING_LENGTH
        ? { code: "tooLong" }
        : { value: textOrNull(v.revisionSummary) },
  },
];

/** The keys `ctx`'s class may send on `ctx.mode` (WIKI_FIELDS). */
export function wikiPageKeys(ctx: Pick<WikiPagePayloadContext, "mode" | "roleClass">): string[] {
  const fields = WIKI_FIELDS.wikiPage;
  if (ctx.mode === "create") {
    return [...(ctx.roleClass === "moderator" ? fields.create.moderator : fields.create.author)];
  }
  return [...fields.update[ctx.roleClass]];
}

/**
 * A page's payload. The edit note (`revisionSummary`) is sent only when the
 * author wrote one: it is not stored on the page, it labels the history
 * entry this save records.
 */
export function buildWikiPagePayload(
  values: WikiPageValues,
  initial: WikiPageValues | null,
  ctx: WikiPagePayloadContext,
): BuiltPayload {
  const { data, fields } = collectFields<WikiPageValues, WikiPagePayloadContext>(
    new Set(wikiPageKeys(ctx)),
    new Set<string>(),
    PAGE_RULES,
    values,
    initial,
    ctx,
  );
  if (data.revisionSummary === null) delete data.revisionSummary;
  return done(data, fields);
}

/**
 * `publishAt` from the Schedule… dialog (moderators, §D): a wall time in
 * reject mode, at least a minute ahead; empty removes the schedule.
 */
export function buildWikiSchedulePayload(
  schedule: ScheduleValues,
  ctx: Pick<WikiPagePayloadContext, "timeZone" | "now">,
): BuiltPayload {
  const fields: Record<string, ManageErrorCode> = {};
  const publishAt = wallTimeInstant(schedule.publishDate, schedule.publishTime, ctx.timeZone);
  if ("code" in publishAt) return done({}, { publishAt: publishAt.code });
  const codes = scheduleCodes({ publishAt: publishAt.value }, ctx.now);
  if (codes.publishAt) fields.publishAt = codes.publishAt;
  return done({ publishAt: publishAt.value }, fields);
}
