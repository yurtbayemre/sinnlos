import { randomBytes } from "node:crypto";
import {
  DOCUMENT_CATEGORIES,
  MAX_POLL_OPTION_LENGTH,
  MAX_TARGET_DEPARTMENTS,
  MAX_VALIDITY_MONTHS,
  QUICK_LINK_CATEGORIES,
  validateQuiz,
  youtubeVideoId,
  WIKI_SPACE_VISIBILITIES,
  checkBoolean,
  checkEnum,
  checkIconKey,
  checkInstant,
  checkMarkdown,
  checkNullableInstant,
  checkNullableString,
  checkNullableWebUrl,
  checkOrder,
  checkPositiveIntOrNull,
  checkQuickLinkUrl,
  checkRequiredString,
  dutyShiftsCode,
  dutyTemplatesCode,
  KPI_AGGREGATIONS,
  KPI_PERIODS,
  isKpiPeriod,
  kpiValuesCode,
  eventSpanCode,
  pollOptionsCode,
  samePollOptions,
  scheduleCodes,
  type AuthoringFieldCode,
} from "@sinnlos/domain";
import { errors, strings } from "@strapi/utils";
import { ROLE_PRIVILEGE_ORDER, STAFF_ROLES, type RoleType } from "../bootstrap/roles";
import {
  ANNOUNCEMENT_UID,
  COURSE_UID,
  LESSON_UID,
  DOCUMENT_UID,
  DUTY_PLAN_UID,
  EVENT_UID,
  KPI_UID,
  QUICK_LINK_UID,
  DEPARTMENT_UID as DEPARTMENT,
  TEAM_UID as TEAM,
  WIKI_PAGE_UID as WIKI_PAGE,
  WIKI_SPACE_UID as WIKI_SPACE,
} from "./authoring-uids";
import { parseRowId } from "./entry-id";
import { isOff } from "./module-switches";
import { isPlainDate, zonedDateKey, zonedDayStart } from "./plain-date";
import { forcePublishedStatus, getMutableQuery } from "./policy-query";
import { appTimeZone } from "./time";

/**
 * Field-level write allowlists for content-API writes (FX07; v2 authoring,
 * deep-dive decision 06 §B1, batch 15 lane 15A).
 *
 * Why: the write policies used to be ROW gates only. Once a caller passed
 * them, the core controller took every attribute from the payload: re-links
 * of rows the caller does not own (a wiki page's `space`/`parent`, a team's
 * `members`, a department's `pages`), and, for admin_role and editor, every
 * attribute of every type, `author` pointing at anyone included. The
 * relation guard (restricted-relations.ts) TRUSTS wiki-page.parent/children,
 * wiki-space.pages and wiki-revision.page to stay inside one wiki space, so
 * a cross-space link written here was readable through them.
 *
 * The model is declarative and the one extension point of v2 authoring:
 *   content type → write action → ROLE CLASS → rule (the allowed fields,
 *   what the server derives, the checks across fields).
 * A role class is the caller's relation to the row being written: "departmentHead" of
 * this department, "teamLead" of this team, "author" of this page, and since
 * batch 15 "moderator" (admin_role/editor on the five phase-1 types) and
 * "departmentAuthor" (a department head on their department's announcement,
 * event or document, §N). The route's write policy decides the row gate and
 * the class, then calls enforceWriteAllowlist() once: the only place the
 * payload is checked for that route. routes.matrix.test.ts pins which
 * policy enforces which (type, action, classes), and that every write route
 * a role holds on these types goes through one.
 *
 * Every authored write, including moderator and organisation writes, uses
 * its role class's allowlist. Org moderator means admin_role only.
 *
 * For every class:
 *   - every payload key must be listed for the class, otherwise the request
 *     fails with ONE generic 400 naming the offending keys (`details.keys`,
 *     sorted). That includes inverse sides, ownership and placement
 *     (`author`, `organizer`, `uploadedBy`, `ownerDepartment`, ...), the
 *     targeting flags (`audience`, `notifyAudience`, `retargetRequired`),
 *     bookkeeping (`scheduleError`), media without its check and Strapi's own
 *     keys (id, documentId, publishedAt, locale, ...).
 *   - a listed value must pass its check. A refused value answers with its
 *     key too, and, where the check names a reason, with a code
 *     (`details.codes`, @sinnlos/domain authoring/codes.ts: `tooLong`,
 *     `invalidInstant`, `scheduleInPast`, ...). A relation, role or media
 *     value that does not resolve, is hidden, draft-only, foreign or outside
 *     the caller's department answers exactly like a malformed one: its key
 *     and NO code. That is the no-existence-oracle rule.
 *   - relation fields accept every Strapi input shape (raw id, numeric
 *     string, documentId, {id}, {documentId}, arrays, {set}, {connect},
 *     {disconnect}, null) for a to-one relation, and a list or `{ set }` for
 *     a to-many one (full replacement; null or [] clears it). A named check
 *     the policy supplies resolves and authorizes every target, and the
 *     payload is rewritten to `{ set: [{ documentId }] }`, so Strapi
 *     resolves exactly the documents that were checked. Audience roles are
 *     written as role TYPES (`member`, `team_lead`) and resolved to the
 *     users-permissions roles on the server, so no class needs `role.find`.
 *   - `callerFields` are set to the caller's user id on create; the payload
 *     may not name them. That ends an author's self-notification: the
 *     notification lifecycles leave out the announcement's author and the
 *     event's organizer.
 *   - `derivedFields` are computed from the accepted payload (unique uids:
 *     a client-chosen value would answer "does a hidden row use this
 *     value?"); `derivedFromMerged` from the stored draft overlaid with the
 *     accepted payload, and only when the payload carries one of the
 *     derivation's trigger keys; `derivedOnCreate` from the caller on
 *     create (`ownerDepartment`).
 *   - TARGETING FLAGS NEVER WIDEN IMPLICITLY (batch 15 contract K10). The
 *     announcement and poll/document/quick-link `audience` and the event
 *     `notifyAudience` are re-derived ("departments" iff a target is
 *     linked, else "all") only when the payload carries a targeting key
 *     (`department`/`team`, or `departments`); the announcement marker
 *     `retargetRequired` is set to false only when the payload carries
 *     `department`, `team` or `audienceRoles`. A payload without one leaves
 *     the stored flag alone, so an item whose targets a department delete
 *     removed stays restricted until someone re-targets it explicitly.
 *   - `crossCheck` rules run over the stored draft overlaid with the
 *     accepted payload (end >= start, all-day midnights, the schedule
 *     order, an acknowledgement deadline needs the acknowledgement), each
 *     only when the payload carries one of its fields.
 *   - `frozenWhen`: a poll's `options` and `anonymous` are refused
 *     (`frozenAfterVotes`) when they differ from the PUBLISHED row's and a
 *     vote exists. An early refusal: the poll guard re-checks it under the
 *     poll's lock at the write (utils/poll-audience-guard.ts).
 *   - NO CLIENT QUERY ON WRITES: the authoring controller refuses every
 *     query key but `status` and answers a fixed DTO, so no write hands out
 *     a populated relation. Authors without the moderator class draft only
 *     through dedicated actions (their status is pinned to published on the
 *     FX07 gates below; `editable` is their only draft read).
 *
 * Pure: no Strapi runtime. The relation, role, media and vote checks come
 * in from the enforcing policy, so this module is unit testable on its own
 * (write-allowlist.test.ts).
 */

export const DEPARTMENT_UID = DEPARTMENT;
export const TEAM_UID = TEAM;
export const WIKI_PAGE_UID = WIKI_PAGE;
export const WIKI_SPACE_UID = WIKI_SPACE;
export const POLL_UID = "api::poll.poll";

/** The role class of admin_role/editor on the authored types (§B1.1). */
export const MODERATOR_CLASS = "moderator";
/** The role class of a department head on their department's items (§N). */
export const DEPARTMENT_AUTHOR_CLASS = "departmentAuthor";

export type WriteAction = "create" | "update";

/**
 * A value check: `true` or `null` accepts the value; `false` refuses it
 * with its key only; a string refuses it with that code (`details.codes`).
 * The FX07 checks answer booleans, the authoring checks (@sinnlos/domain
 * validators) a code or null.
 */
export type ValueCheck = (value: unknown) => boolean | string | null;

/** The async check a `frozenWhen` field asks once its value changed. */
export type FrozenCheckName = "pollHasVotes";

/** A schema attribute stored as sent, after `check` accepted it. */
export interface ValueField {
  kind: "value";
  check: ValueCheck;
  /**
   * Refused (`frozenAfterVotes`) when the value differs from the PUBLISHED
   * row's (by `same`) and the named check answers true (§B1.2 frozenWhen).
   */
  frozenWhen?: { check: FrozenCheckName; same: (a: unknown, b: unknown) => boolean };
}

/**
 * Not a schema attribute: the route's controller consumes it before the
 * core sees the payload (wiki-page `revisionSummary`).
 */
export interface ControllerField {
  kind: "controller";
  check: ValueCheck;
}

/** Names of the async to-one relation checks the FX07 wiki gate supplies. */
export type RelationCheckName = "wikiSpace" | "wikiParent";

/** Names of the to-one relation checks the v2 write gate supplies (utils/authoring-checks.ts). */
export type AuthoringRelationCheckName =
  "department" | "team" | "callerDepartment" | "teamOfCallerDepartment" | "course" | "user";

/** Every named to-one relation check. */
export type AnyRelationCheckName = RelationCheckName | AuthoringRelationCheckName;

/** A to-one relation, resolved and authorized by a named async check. */
export interface RelationField {
  kind: "relation";
  check: AnyRelationCheckName;
  /** The payload must name exactly one target (no clear, no disconnect). */
  required?: boolean;
  /** On create, a missing key is the caller's department (§N4 callerDepartment). */
  callerDepartmentOnCreate?: boolean;
}

/** Names of the async to-many relation checks a policy can supply. */
export type RelationListCheckName = "departments" | "callerDepartments" | "users";

/** A to-many relation, written as a full replacement and resolved by a named check. */
export interface RelationListField {
  kind: "relationList";
  check: RelationListCheckName;
  /** Most targets one payload may name. */
  max: number;
  /** On create, a missing key is `[the caller's department]` (§N4 callerDepartment). */
  callerDepartmentOnCreate?: boolean;
  /**
   * `{ connect, disconnect }` changes instead of a full replacement (team
   * members, v0.22): a stale form cannot undo a change it did not see, made
   * through a path that does not advance the document's revision (the
   * user's side of the relation in the admin panel).
   */
  delta?: boolean;
}

/**
 * Audience roles as intranet role TYPES (§B1.2 roleTypes): each one of
 * `allowed`, resolved to the users-permissions role on the server, so the
 * caller needs no `role.find`. `public` and `authenticated` are never in
 * `allowed`.
 */
export interface RoleTypesField {
  kind: "roleTypes";
  allowed: readonly RoleType[];
  max: number;
}

/** Names of the async media checks a policy can supply. */
export type MediaCheckName = "ownUpload";

/**
 * A single media field: a file row id authorized by a named check. The
 * field's current value on the stored draft passes unchecked (keeping a
 * file is not attaching it, §E2).
 */
export interface MediaField {
  kind: "media";
  check: MediaCheckName;
}

export type FieldSpec =
  ValueField | ControllerField | RelationField | RelationListField | RoleTypesField | MediaField;

/** Computes an attribute from the accepted (already checked) payload. */
export type DerivedField = (accepted: Readonly<Record<string, unknown>>) => unknown;

/**
 * Computes an attribute from the stored draft overlaid with the accepted
 * payload (relations as documentIds, audience roles as role types), when
 * the payload carries one of `when`.
 */
export interface MergedDerivation {
  when: readonly string[];
  derive: (merged: Readonly<Record<string, unknown>>) => unknown;
}

/** Computes an attribute on create from the caller (§B1.2 derivedOnCreate). */
export type CreateDerivation = (env: WriteRuleEnvironment) => unknown;

/**
 * A rule over several fields: gets the stored draft overlaid with the
 * accepted payload and the keys the payload carried, returns the keys to
 * refuse with their codes.
 */
export type CrossCheck = (
  merged: Readonly<Record<string, unknown>>,
  carried: ReadonlySet<string>,
  env: WriteRuleEnvironment,
) => Partial<Record<string, string>>;

export interface WriteRule {
  /**
   * The only keys a payload may carry. Relation checks run in THIS order,
   * so a check can rely on an earlier relation (wiki `parent` on create
   * needs the `space` resolved first).
   */
  fields: Readonly<Record<string, FieldSpec>>;
  /** Attributes set to the caller's user id; the payload may not name them. */
  callerFields?: readonly string[];
  /** Attributes the server computes from the accepted payload; the payload may not name them. */
  derivedFields?: Readonly<Record<string, DerivedField>>;
  /** Attributes the server re-derives from stored ⊕ payload (targeting flags). */
  derivedFromMerged?: Readonly<Record<string, MergedDerivation>>;
  /** Attributes the server sets on create from the caller (`ownerDepartment`). */
  derivedOnCreate?: Readonly<Record<string, CreateDerivation>>;
  crossCheck?: CrossCheck;
  /**
   * Early publish readiness (§D rule 3): when the payload sets `publishAt`,
   * the draft must be publishable (`notPublishable` on the keys that
   * block). The authoritative check runs at every publish (§G2).
   */
  readinessWhenScheduled?: boolean;
}

export type WriteAllowlist = Readonly<
  Record<string, Partial<Record<WriteAction, Readonly<Record<string, WriteRule>>>>>
>;

// ---------------------------------------------------------------------------
// Value checks (FX07: booleans)
// ---------------------------------------------------------------------------

/** Strapi `string` attributes are varchar(255) columns on Postgres. */
const MAX_STRING_LENGTH = 255;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
export const MAX_TAGS = 50;
export const MAX_TAG_LENGTH = 100;

const isString = (value: unknown): value is string => typeof value === "string";

export const valueChecks = {
  /** A non-blank `string` attribute. */
  requiredString: (value: unknown) =>
    isString(value) && value.trim().length > 0 && value.length <= MAX_STRING_LENGTH,
  /** `text` / `richtext`: any string, or null to clear. */
  nullableText: (value: unknown) => value === null || isString(value),
  boolean: (value: unknown) => typeof value === "boolean",
  /** `integer` attributes are int4 columns. */
  int32: (value: unknown) =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= INT32_MIN &&
    value <= INT32_MAX,
  /**
   * `#rrggbb` only: the web appends a two-digit alpha suffix to the stored
   * value (departments list gradient), so the short and alpha forms would
   * render as invalid CSS. Anything else (named colours, url(), ...) is out.
   */
  hexColor: (value: unknown) => isString(value) && /^#[0-9a-fA-F]{6}$/.test(value),
  /** The `json` tags attribute, restricted to a short list of short strings. */
  tags: (value: unknown) =>
    value === null ||
    (Array.isArray(value) &&
      value.length <= MAX_TAGS &&
      value.every(
        (tag: unknown) => isString(tag) && tag.trim().length > 0 && tag.length <= MAX_TAG_LENGTH,
      )),
} satisfies Record<string, ValueCheck>;

// ---------------------------------------------------------------------------
// Value checks (v2 authoring: codes, @sinnlos/domain authoring/validators.ts)
// ---------------------------------------------------------------------------

/** A `date` attribute: 'YYYY-MM-DD' naming a real day, or null. */
const checkNullablePlainDate: ValueCheck = (value) =>
  value === null || isPlainDate(value) ? null : "invalidDate";

/**
 * `requiresAck`: a boolean, and never `true` while `read-confirmations` is
 * in FEATURES_OFF (v0.28): nobody could confirm it. `false` stays writable,
 * so a form can clear the flag of an older document.
 */
const checkAckFlag: ValueCheck = (value) =>
  checkBoolean(value) ?? (value === true && isOff("read-confirmations") ? "invalid" : null);

/** Poll options: 2-20 unique trimmed answers of at most 200 characters (plan item 2b). */
const checkPollOptions: ValueCheck = (value) =>
  pollOptionsCode(value, { maxLength: MAX_POLL_OPTION_LENGTH });

/** The schema enum of an `enumeration` attribute. */
const enumOf = (values: readonly string[]): ValueCheck => checkEnum(values);

const value = (check: ValueCheck): ValueField => ({ kind: "value", check });
const toOne = (
  check: AnyRelationCheckName,
  options: { required?: boolean; callerDepartmentOnCreate?: boolean } = {},
): RelationField => ({ kind: "relation", check, ...options });
const toMany = (
  check: RelationListCheckName,
  options: { max?: number; callerDepartmentOnCreate?: boolean; delta?: boolean } = {},
): RelationListField => ({
  kind: "relationList",
  check,
  max: options.max ?? MAX_TARGET_DEPARTMENTS,
  ...(options.callerDepartmentOnCreate ? { callerDepartmentOnCreate: true } : {}),
  ...(options.delta ? { delta: true } : {}),
});
/** A single media field authorized by a named check (§B1.2 media; retain passes unchecked). */
const media = (check: MediaCheckName): MediaField => ({ kind: "media", check });
const roleTypes = (allowed: readonly RoleType[]): RoleTypesField => ({
  kind: "roleTypes",
  allowed,
  max: allowed.length,
});
/** A boolean that is never null in a comparison: a NULL column reads as false. */
const sameFlag = (a: unknown, b: unknown) => (a === true) === (b === true);
const frozen = (check: ValueCheck, same: (a: unknown, b: unknown) => boolean): ValueField => ({
  kind: "value",
  check,
  frozenWhen: { check: "pollHasVotes", same },
});

// ---------------------------------------------------------------------------
// Derived fields
// ---------------------------------------------------------------------------

/** Longest slugified title kept in front of the random suffix. */
export const SLUG_BASE_MAX_LENGTH = 60;
/** The base for a title that slugifies to nothing ("写真", "🙂", "---"). */
export const SLUG_FALLBACK_BASE = "page";

/**
 * A `uid` value `<slug of accepted[source]>-<8 random hex>`, e.g.
 * "ueber-uns-3f9a2c1b". The base uses Strapi's own slugify (the admin
 * panel's uid generator, German transliteration included); the suffix is
 * random, so whether the value is taken says nothing about any other page,
 * and two pages with one title still get distinct slugs (32 random bits).
 * The web resolves a page by space slug + page slug, so any unique value
 * works as a URL.
 */
export function uniqueSlugFrom(source: string): DerivedField {
  return (accepted) => {
    const text = accepted[source];
    const base = (isString(text) ? strings.nameToSlug(text) : "")
      .slice(0, SLUG_BASE_MAX_LENGTH)
      .replace(/-+$/, "");
    const safeBase = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(base) ? base : SLUG_FALLBACK_BASE;
    return `${safeBase}-${randomBytes(4).toString("hex")}`;
  };
}

const AUDIENCE_DEPARTMENTS = "departments";
const AUDIENCE_ALL = "all";

const linked = (value: unknown): boolean =>
  Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined;

/**
 * `audience` of an announcement: "departments" iff a department or a team
 * is linked (stored ⊕ payload), re-derived only when the payload carries
 * `department` or `team` (contract K10).
 */
const ANNOUNCEMENT_AUDIENCE: MergedDerivation = {
  when: ["department", "team"],
  derive: (merged) =>
    linked(merged.department) || linked(merged.team) ? AUDIENCE_DEPARTMENTS : AUDIENCE_ALL,
};

/**
 * The `retargetRequired` marker (amendment row A3) is lowered only by an
 * explicit re-target: a payload with `department`, `team` or
 * `audienceRoles` (contract K10). The delete hooks (15D) raise it.
 */
const ANNOUNCEMENT_RETARGET: MergedDerivation = {
  when: ["department", "team", "audienceRoles"],
  derive: () => false,
};

/** `audience` (poll, document, quick link) or `notifyAudience` (event) from `departments`. */
const DEPARTMENTS_FLAG: MergedDerivation = {
  when: ["departments"],
  derive: (merged) => (linked(merged.departments) ? AUDIENCE_DEPARTMENTS : AUDIENCE_ALL),
};

/** `ownerDepartment` on a department author's create: their department (§N3). */
const OWNER_DEPARTMENT: CreateDerivation = (env) => {
  const department = env.callerDepartment;
  // A departmentAuthor rule without the caller's department is a wiring
  // bug of the gate: fail the request instead of writing an unowned item.
  if (!department) throw new Error("write allowlist: ownerDepartment needs the caller department");
  return { set: [{ documentId: department.documentId }] };
};

// ---------------------------------------------------------------------------
// Cross-field checks
// ---------------------------------------------------------------------------

const carriesAny = (carried: ReadonlySet<string>, keys: readonly string[]) =>
  keys.some((key) => carried.has(key));

/**
 * The schedule order (§D rule 3): `publishAt` at least a minute ahead when
 * the payload sets it, `unpublishAt` and an announcement's `expiresAt`
 * after it, each only when the payload carries one of the fields compared.
 */
function scheduleCheck(
  merged: Readonly<Record<string, unknown>>,
  carried: ReadonlySet<string>,
  env: WriteRuleEnvironment,
): Partial<Record<string, string>> {
  const codes = scheduleCodes(merged, env.now ?? Date.now(), {
    publishAtChanged: carried.has("publishAt"),
  });
  const out: Partial<Record<string, string>> = {};
  if (codes.publishAt && carried.has("publishAt")) out.publishAt = codes.publishAt;
  if (codes.unpublishAt && carriesAny(carried, ["publishAt", "unpublishAt"])) {
    out.unpublishAt = codes.unpublishAt;
  }
  if (codes.expiresAt && carriesAny(carried, ["publishAt", "expiresAt"])) {
    out.expiresAt = codes.expiresAt;
  }
  return out;
}

const announcementCrossCheck: CrossCheck = (merged, carried, env) => {
  const out = scheduleCheck(merged, carried, env);
  if (
    carriesAny(carried, ["ackDeadline", "requiresAck"]) &&
    merged.ackDeadline !== null &&
    merged.ackDeadline !== undefined &&
    merged.requiresAck !== true
  ) {
    out.ackDeadline = "ackDeadlineWithoutAck" satisfies AuthoringFieldCode;
  }
  return out;
};

/** Whether an instant (ISO-Z) is a local midnight of `timeZone`. */
export function isZonedMidnight(instant: string, timeZone: string): boolean {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return false;
  return zonedDayStart(zonedDateKey(instant, timeZone), timeZone).getTime() === ms;
}

/**
 * Events: end >= start, and an all-day event's start and end at local
 * midnights of APP_TIME_ZONE (the web sends zonedDayStart of the first and
 * the last day, decision 04 C7).
 */
const eventCrossCheck: CrossCheck = (merged, carried, env) => {
  const out = scheduleCheck(merged, carried, env);
  if (carriesAny(carried, ["start", "end"])) {
    const span = eventSpanCode(merged.start, merged.end);
    if (span) out.end = span;
  }
  if (carriesAny(carried, ["start", "end", "allDay"]) && merged.allDay === true) {
    const zone = appTimeZone();
    for (const key of ["start", "end"] as const) {
      const instant = merged[key];
      if (isString(instant) && !isZonedMidnight(instant, zone) && out[key] === undefined) {
        out[key] = "notMidnight" satisfies AuthoringFieldCode;
      }
    }
  }
  return out;
};

const scheduledCrossCheck: CrossCheck = scheduleCheck;

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

/**
 * Wiki page content a non-privileged author may write. Not `slug`: it is a
 * globally unique uid, so the server derives it on create (uniqueSlugFrom)
 * and it stays fixed afterwards (admins and editors may still change it).
 * `tags`, `tocEnabled` and `order` stay writable: the web renders them
 * since DA02 (owner answer 2026-09-29 (b); apps/web/src/lib/wiki-content.ts:
 * chips, the table of contents, the space's page order).
 */
const WIKI_PAGE_CONTENT = {
  title: value(valueChecks.requiredString),
  body: value(valueChecks.nullableText),
  summary: value(valueChecks.nullableText),
  tags: value(valueChecks.tags),
  tocEnabled: value(valueChecks.boolean),
  order: value(valueChecks.int32),
};

/** The edit note: stripped by the controller and handed to the revision lifecycle. */
const REVISION_SUMMARY: ControllerField = { kind: "controller", check: valueChecks.nullableText };

/**
 * Updating a page as its author, the head of its department or the lead of
 * its team (can-edit-wiki's row classes). `space` is create-only: moving a
 * page between spaces stays in the admin panel. `parent` must be a visible
 * page of the page's own space; when it CHANGES, neither the page itself
 * nor one of its descendants (an early refusal; the wiki checks refuse any
 * parent loop a write adds under the structure lock, utils/wiki-checks.ts).
 * `lastEditor` is the caller.
 */
const WIKI_PAGE_EDIT: WriteRule = {
  fields: {
    ...WIKI_PAGE_CONTENT,
    parent: toOne("wikiParent"),
    revisionSummary: REVISION_SUMMARY,
  },
  callerFields: ["lastEditor"],
};

/**
 * A page created by a department head or team lead (class `author`). The
 * `space` must be one the caller can READ, `parent` a readable page of
 * that space. Visibility, not a separate edit right, is the bar: the schema
 * has no per-space editor list, a new page only lands where its author can
 * already read (so none of its relations reaches a hidden row), and what a
 * page says in a shared space is a moderation matter (moderators delete
 * pages).
 */
const WIKI_PAGE_AUTHOR_CREATE: WriteRule = {
  fields: {
    ...WIKI_PAGE_CONTENT,
    space: toOne("wikiSpace", { required: true }),
    parent: toOne("wikiParent"),
  },
  callerFields: ["author", "lastEditor"],
  derivedFields: { slug: uniqueSlugFrom("title") },
};

/**
 * Wiki pages for moderators (§J2, batch 16): the content, `space` on create
 * (any space with a published row), `parent` in the page's space (a draft
 * parent too; publishing needs it published, utils/publish-readiness.ts),
 * department and team, the schedule (`publishAt`, a minute ahead; the page
 * must be publishable) and the edit note. No space move and no slug edit:
 * both stay in the admin panel (a move needs the page's whole subtree).
 */
const WIKI_PAGE_MODERATOR_COMMON = {
  parent: toOne("wikiParent"),
  department: toOne("department"),
  team: toOne("team"),
  publishAt: value(checkNullableInstant),
  revisionSummary: REVISION_SUMMARY,
};

const WIKI_PAGE_MODERATOR_CREATE: WriteRule = {
  // Rule order is check order: `parent` needs the `space` resolved first.
  fields: {
    ...WIKI_PAGE_CONTENT,
    space: toOne("wikiSpace", { required: true }),
    ...WIKI_PAGE_MODERATOR_COMMON,
  },
  callerFields: ["author", "lastEditor"],
  derivedFields: { slug: uniqueSlugFrom("title") },
  crossCheck: scheduledCrossCheck,
  readinessWhenScheduled: true,
};

const WIKI_PAGE_MODERATOR_UPDATE: WriteRule = {
  fields: { ...WIKI_PAGE_CONTENT, ...WIKI_PAGE_MODERATOR_COMMON },
  callerFields: ["lastEditor"],
  crossCheck: scheduledCrossCheck,
  readinessWhenScheduled: true,
};

/** The target attribute each wiki-space visibility needs (§B6; visible-ids.ts reads them). */
export const WIKI_SPACE_VISIBILITY_TARGETS: Readonly<Record<string, string>> = {
  role: "allowedRoles",
  department: "department",
  team: "team",
};

/**
 * A space's visibility needs its target (§B1.2 crossCheck): `role` some
 * allowed roles, `department` a department, `team` a team; the refusal
 * (`visibilityTarget`) lands on the missing target. Checked only when the
 * payload carries the visibility or a target, so a space whose department a
 * delete removed does not block an unrelated save.
 */
const wikiSpaceCrossCheck: CrossCheck = (merged, carried) => {
  if (!carriesAny(carried, ["visibility", ...Object.values(WIKI_SPACE_VISIBILITY_TARGETS)])) {
    return {};
  }
  const target = WIKI_SPACE_VISIBILITY_TARGETS[String(merged.visibility)];
  if (!target || linked(merged[target])) return {};
  return { [target]: "visibilityTarget" satisfies AuthoringFieldCode };
};

/**
 * Wiki spaces (moderators; §J1, §B3: always published). Name, icon (an icon
 * key or null), description, visibility with its target (allowed roles as
 * role types, department, team). The slug is derived from the name on
 * create and stays fixed; `pages` is the inverse side and never written.
 */
const WIKI_SPACE_MODERATOR: WriteRule = {
  fields: {
    name: value(checkRequiredString),
    icon: value(checkIconKey),
    description: value(checkMarkdown),
    visibility: value(enumOf(WIKI_SPACE_VISIBILITIES)),
    allowedRoles: roleTypes(ROLE_PRIVILEGE_ORDER),
    department: toOne("department"),
    team: toOne("team"),
  },
  crossCheck: wikiSpaceCrossCheck,
};

/** Team leads and department heads edit text; structural fields stay in the panel. */
const TEAM_EDIT: WriteRule = {
  fields: { description: value(checkMarkdown) },
};
const DEPARTMENT_EDIT: WriteRule = {
  fields: { description: value(checkMarkdown), color: value(valueChecks.hexColor) },
};
/** Most members one team payload may name (a full replacement list). */
const MAX_TEAM_MEMBERS = 1000;
/** admin_role manages the structure (v0.22, deep-dive plan-org-users.md); the slug stays as created. */
const DEPARTMENT_MODERATOR: WriteRule = {
  fields: {
    ...DEPARTMENT_EDIT.fields,
    name: value(checkRequiredString),
    headerImage: media("ownUpload"),
    head: toOne("user"),
  },
};
const TEAM_MODERATOR: WriteRule = {
  fields: {
    ...TEAM_EDIT.fields,
    name: value(checkRequiredString),
    avatar: media("ownUpload"),
    department: toOne("department"),
    lead: toOne("user"),
    members: toMany("users", { max: MAX_TEAM_MEMBERS, delta: true }),
  },
};
const COURSE_MODERATOR: WriteRule = {
  fields: {
    title: value(checkRequiredString),
    description: value(checkMarkdown),
    mandatory: value(checkBoolean),
    completionMode: value(checkEnum(["confirm", "quizGate", "exam"])),
    validityMonths: value((raw) =>
      raw === null ||
      (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= MAX_VALIDITY_MONTHS)
        ? null
        : "invalid",
    ),
    // v0.28: who answers questions about the course ("Fragen an"), free text.
    contact: value(checkNullableString),
    departments: toMany("departments"),
    coverImage: media("ownUpload"),
    publishAt: value(checkNullableInstant),
  },
  derivedFromMerged: { audience: DEPARTMENTS_FLAG },
  crossCheck: scheduledCrossCheck,
  readinessWhenScheduled: true,
};
const LESSON_MODERATOR: WriteRule = {
  fields: {
    title: value(checkRequiredString),
    body: value(checkMarkdown),
    order: value(checkOrder),
    course: toOne("course"),
    videoUrl: value((raw) =>
      raw === null || raw === ""
        ? null
        : (checkNullableString(raw) ?? (youtubeVideoId(raw) ? null : "videoUrlNotYoutube")),
    ),
    quiz: value((raw) => ("error" in validateQuiz(raw) ? "quizInvalid" : null)),
    publishAt: value(checkNullableInstant),
  },
  crossCheck: scheduledCrossCheck,
  readinessWhenScheduled: true,
};

// ---- v2 authoring, batch 15: the five phase-1 types ------------------------
//
// One rule per (type, class), create and update sharing the fields
// (@sinnlos/domain authoring/fields.ts lists them; write-allowlist.test.ts
// pins both equal). Create rules add the caller field and, for department
// authors, the owner. Department authors (§N6): no pinning, no
// acknowledgement, no schedule, and the targeting pinned to their
// department: `callerDepartment` (exactly the caller's department; set on
// create when missing), `teamOfCallerDepartment` (null, or a team of it),
// audience roles from the staff role types only.

const ANNOUNCEMENT_COMMON = {
  title: value(checkRequiredString),
  body: value(checkMarkdown),
  expiresAt: value(checkNullableInstant),
};

const ANNOUNCEMENT_DERIVED = {
  audience: ANNOUNCEMENT_AUDIENCE,
  retargetRequired: ANNOUNCEMENT_RETARGET,
};

const ANNOUNCEMENT_MODERATOR: WriteRule = {
  fields: {
    ...ANNOUNCEMENT_COMMON,
    pinned: value(checkBoolean),
    department: toOne("department"),
    team: toOne("team"),
    audienceRoles: roleTypes(ROLE_PRIVILEGE_ORDER),
    requiresAck: value(checkAckFlag),
    ackDeadline: value(checkNullablePlainDate),
    publishAt: value(checkNullableInstant),
  },
  derivedFromMerged: ANNOUNCEMENT_DERIVED,
  crossCheck: announcementCrossCheck,
  readinessWhenScheduled: true,
};

const ANNOUNCEMENT_DEPARTMENT_AUTHOR: WriteRule = {
  fields: {
    ...ANNOUNCEMENT_COMMON,
    department: toOne("callerDepartment", { callerDepartmentOnCreate: true }),
    team: toOne("teamOfCallerDepartment"),
    audienceRoles: roleTypes(STAFF_ROLES),
  },
  derivedFromMerged: ANNOUNCEMENT_DERIVED,
  crossCheck: announcementCrossCheck,
};

const EVENT_COMMON = {
  title: value(checkRequiredString),
  description: value(checkMarkdown),
  start: value(checkInstant),
  end: value(checkNullableInstant),
  allDay: value(checkBoolean),
  location: value(checkNullableString),
  url: value(checkNullableWebUrl),
  rsvpEnabled: value(checkBoolean),
  capacity: value(checkPositiveIntOrNull),
};

const EVENT_MODERATOR: WriteRule = {
  fields: {
    ...EVENT_COMMON,
    departments: toMany("departments"),
    publishAt: value(checkNullableInstant),
  },
  derivedFromMerged: { notifyAudience: DEPARTMENTS_FLAG },
  crossCheck: eventCrossCheck,
  readinessWhenScheduled: true,
};

const EVENT_DEPARTMENT_AUTHOR: WriteRule = {
  fields: {
    ...EVENT_COMMON,
    departments: toMany("callerDepartments", { callerDepartmentOnCreate: true }),
  },
  derivedFromMerged: { notifyAudience: DEPARTMENTS_FLAG },
  crossCheck: eventCrossCheck,
};

const QUICK_LINK_MODERATOR: WriteRule = {
  fields: {
    label: value(checkRequiredString),
    url: value(checkQuickLinkUrl),
    icon: value(checkIconKey),
    category: value(enumOf(QUICK_LINK_CATEGORIES)),
    order: value(checkOrder),
    departments: toMany("departments"),
    publishAt: value(checkNullableInstant),
    unpublishAt: value(checkNullableInstant),
  },
  derivedFromMerged: { audience: DEPARTMENTS_FLAG },
  crossCheck: scheduledCrossCheck,
  readinessWhenScheduled: true,
};

const DOCUMENT_COMMON = {
  title: value(checkRequiredString),
  description: value(checkMarkdown),
  category: value(enumOf(DOCUMENT_CATEGORIES)),
};

/**
 * `file` (batch 16, §E2): a file row id the caller uploaded and nothing
 * else links (`ownUpload`, utils/authoring-checks.ts), an early refusal;
 * the media claims re-check it under the file row's lock at the write
 * (utils/media-claims.ts, document-middlewares slot 7). Keeping the stored
 * file passes unchecked, null clears it.
 */
const DOCUMENT_MODERATOR: WriteRule = {
  fields: {
    ...DOCUMENT_COMMON,
    departments: toMany("departments"),
    file: media("ownUpload"),
    requiresAck: value(checkAckFlag),
    publishAt: value(checkNullableInstant),
    unpublishAt: value(checkNullableInstant),
  },
  derivedFromMerged: { audience: DEPARTMENTS_FLAG },
  crossCheck: scheduledCrossCheck,
  readinessWhenScheduled: true,
};

const DOCUMENT_DEPARTMENT_AUTHOR: WriteRule = {
  fields: {
    ...DOCUMENT_COMMON,
    departments: toMany("callerDepartments", { callerDepartmentOnCreate: true }),
    file: media("ownUpload"),
  },
  derivedFromMerged: { audience: DEPARTMENTS_FLAG },
  crossCheck: scheduledCrossCheck,
};

const POLL_MODERATOR: WriteRule = {
  fields: {
    question: value(checkRequiredString),
    options: frozen(checkPollOptions, samePollOptions),
    closesAt: value(checkNullableInstant),
    anonymous: frozen(checkBoolean, sameFlag),
    departments: toMany("departments"),
    visibleToGuests: value(checkBoolean),
    guestsCanVote: value(checkBoolean),
  },
  derivedFromMerged: { audience: DEPARTMENTS_FLAG },
};

const withCreate = (
  rule: WriteRule,
  callerField: string,
  owner: boolean,
): { create: WriteRule; update: WriteRule } => ({
  create: {
    ...rule,
    callerFields: [callerField],
    ...(owner ? { derivedOnCreate: { ownerDepartment: OWNER_DEPARTMENT } } : {}),
  },
  update: rule,
});

const ANNOUNCEMENT_RULES = {
  moderator: withCreate(ANNOUNCEMENT_MODERATOR, "author", false),
  departmentAuthor: withCreate(ANNOUNCEMENT_DEPARTMENT_AUTHOR, "author", true),
};
const EVENT_RULES = {
  moderator: withCreate(EVENT_MODERATOR, "organizer", false),
  departmentAuthor: withCreate(EVENT_DEPARTMENT_AUTHOR, "organizer", true),
};
const DOCUMENT_RULES = {
  moderator: withCreate(DOCUMENT_MODERATOR, "uploadedBy", false),
  departmentAuthor: withCreate(DOCUMENT_DEPARTMENT_AUTHOR, "uploadedBy", true),
};
const POLL_RULES = { moderator: withCreate(POLL_MODERATOR, "author", false) };

// ---- v0.18: duty plans -------------------------------------------------------
//
// The shift templates and shifts are JSON lists checked by the shared rules
// (@sinnlos/domain duty.ts); the lifecycle normalises what is stored. A
// moderator picks any department or none (company-wide); the plan's
// ownerDepartment follows it, so that department's heads and team leads
// maintain the plan too. A department author's department is their own.
// shortcut: user ids in `shifts` are not checked to exist (staff read the
// directory anyway); an unknown id renders as an unknown person. Add an
// async check if ids ever come from outside the web form.

const DUTY_PLAN_COMMON = {
  name: value(checkRequiredString),
  note: value(checkNullableString),
  shiftTemplates: value(dutyTemplatesCode),
  shifts: value(dutyShiftsCode),
};

const DUTY_PLAN_OWNER: MergedDerivation = {
  when: ["department"],
  derive: (merged) =>
    typeof merged.department === "string" ? { set: [{ documentId: merged.department }] } : null,
};

const DUTY_PLAN_MODERATOR: WriteRule = {
  fields: { ...DUTY_PLAN_COMMON, department: toOne("department") },
  derivedFromMerged: { ownerDepartment: DUTY_PLAN_OWNER },
};

const DUTY_PLAN_DEPARTMENT_AUTHOR: WriteRule = {
  fields: {
    ...DUTY_PLAN_COMMON,
    department: toOne("callerDepartment", { callerDepartmentOnCreate: true }),
  },
};

const DUTY_PLAN_RULES = {
  moderator: withCreate(DUTY_PLAN_MODERATOR, "author", false),
  departmentAuthor: withCreate(DUTY_PLAN_DEPARTMENT_AUTHOR, "author", true),
};

// ---- v0.19: KPIs ------------------------------------------------------------
//
// Like the duty plans: a moderator picks any department or none
// (company-wide) and ownerDepartment follows it; a department head's KPI
// is their own department's. The values are an object of period starts to
// numbers (@sinnlos/domain kpi.ts); every key must start a period of the
// KPI's rhythm as stored ⊕ payload, so a new rhythm is refused while
// values of the old one are left.

const kpiCrossCheck: CrossCheck = (merged, carried) => {
  if (!carriesAny(carried, ["period", "values"])) return {};
  // Absent on a create without one: the schema default.
  const period = isKpiPeriod(merged.period) ? merged.period : "month";
  if (kpiValuesCode(merged.values, period) === null) return {};
  return { [carried.has("values") ? "values" : "period"]: "invalid" satisfies AuthoringFieldCode };
};

const KPI_COMMON = {
  name: value(checkRequiredString),
  unit: value(checkNullableString),
  description: value(checkNullableString),
  period: value(checkEnum(KPI_PERIODS)),
  aggregation: value(checkEnum(KPI_AGGREGATIONS)),
  values: value(kpiValuesCode),
};

const KPI_MODERATOR: WriteRule = {
  fields: { ...KPI_COMMON, department: toOne("department") },
  derivedFromMerged: { ownerDepartment: DUTY_PLAN_OWNER },
  crossCheck: kpiCrossCheck,
};

const KPI_DEPARTMENT_AUTHOR: WriteRule = {
  fields: {
    ...KPI_COMMON,
    department: toOne("callerDepartment", { callerDepartmentOnCreate: true }),
  },
  crossCheck: kpiCrossCheck,
};

const KPI_RULES = {
  moderator: withCreate(KPI_MODERATOR, "author", false),
  departmentAuthor: withCreate(KPI_DEPARTMENT_AUTHOR, "author", true),
};

/*
 * v2 follow-ups, kept OUT of the table on purpose until each has its own
 * batch and check:
 *   - team `members` / `lead`: admin_role only (v0.22). Lead-managed
 *     membership belongs on a dedicated route with its own rules.
 *   - wiki `space` on update (moving a page) stays in the admin panel; a
 *     move would need the page's whole subtree to follow it.
 *   - wiki `slug` stays server-derived (uniqueSlugFrom); editable slugs
 *     need uniqueness that is scoped to what the caller can read.
 * Wiki authors draft through dedicated actions with a fixed response
 * (createDraft, saveDraft; batch 16), never through a lifted status pin.
 */
export const WRITE_ALLOWLIST = {
  [COURSE_UID]: {
    create: {
      moderator: { ...COURSE_MODERATOR, derivedFields: { slug: uniqueSlugFrom("title") } },
    },
    update: { moderator: COURSE_MODERATOR },
  },
  [LESSON_UID]: {
    create: {
      moderator: {
        ...LESSON_MODERATOR,
        fields: {
          ...LESSON_MODERATOR.fields,
          course: { kind: "relation", check: "course", required: true },
        },
      },
    },
    update: { moderator: LESSON_MODERATOR },
  },
  [DEPARTMENT_UID]: {
    create: {
      moderator: { ...DEPARTMENT_MODERATOR, derivedFields: { slug: uniqueSlugFrom("name") } },
    },
    update: {
      moderator: DEPARTMENT_MODERATOR,
      departmentHead: DEPARTMENT_EDIT,
    },
  },
  [TEAM_UID]: {
    create: {
      moderator: {
        fields: { ...TEAM_MODERATOR.fields, department: toOne("department", { required: true }) },
        derivedFields: { slug: uniqueSlugFrom("name") },
      },
    },
    update: {
      moderator: TEAM_MODERATOR,
      teamLead: TEAM_EDIT,
      // department_head of the team's department: same rights as the lead.
      departmentHead: TEAM_EDIT,
    },
  },
  [WIKI_PAGE_UID]: {
    create: {
      // department_head and team_lead (the create grant), and moderators.
      author: WIKI_PAGE_AUTHOR_CREATE,
      moderator: WIKI_PAGE_MODERATOR_CREATE,
    },
    update: {
      // can-edit-wiki's row classes (domain wiki-edit.ts): the page's
      // author, the head of its department, the lead of its team; and
      // moderators on every page.
      author: WIKI_PAGE_EDIT,
      departmentHead: WIKI_PAGE_EDIT,
      teamLead: WIKI_PAGE_EDIT,
      moderator: WIKI_PAGE_MODERATOR_UPDATE,
    },
  },
  [WIKI_SPACE_UID]: {
    create: {
      moderator: { ...WIKI_SPACE_MODERATOR, derivedFields: { slug: uniqueSlugFrom("name") } },
    },
    update: { moderator: WIKI_SPACE_MODERATOR },
  },
  [ANNOUNCEMENT_UID]: {
    create: {
      moderator: ANNOUNCEMENT_RULES.moderator.create,
      departmentAuthor: ANNOUNCEMENT_RULES.departmentAuthor.create,
    },
    update: {
      moderator: ANNOUNCEMENT_RULES.moderator.update,
      departmentAuthor: ANNOUNCEMENT_RULES.departmentAuthor.update,
    },
  },
  [EVENT_UID]: {
    create: {
      moderator: EVENT_RULES.moderator.create,
      departmentAuthor: EVENT_RULES.departmentAuthor.create,
    },
    update: {
      moderator: EVENT_RULES.moderator.update,
      departmentAuthor: EVENT_RULES.departmentAuthor.update,
    },
  },
  [QUICK_LINK_UID]: {
    create: { moderator: QUICK_LINK_MODERATOR },
    update: { moderator: QUICK_LINK_MODERATOR },
  },
  [DOCUMENT_UID]: {
    create: {
      moderator: DOCUMENT_RULES.moderator.create,
      departmentAuthor: DOCUMENT_RULES.departmentAuthor.create,
    },
    update: {
      moderator: DOCUMENT_RULES.moderator.update,
      departmentAuthor: DOCUMENT_RULES.departmentAuthor.update,
    },
  },
  [POLL_UID]: {
    create: { moderator: POLL_RULES.moderator.create },
    update: { moderator: POLL_RULES.moderator.update },
  },
  [DUTY_PLAN_UID]: {
    create: {
      moderator: DUTY_PLAN_RULES.moderator.create,
      departmentAuthor: DUTY_PLAN_RULES.departmentAuthor.create,
    },
    update: {
      moderator: DUTY_PLAN_RULES.moderator.update,
      departmentAuthor: DUTY_PLAN_RULES.departmentAuthor.update,
    },
  },
  [KPI_UID]: {
    create: {
      moderator: KPI_RULES.moderator.create,
      departmentAuthor: KPI_RULES.departmentAuthor.create,
    },
    update: {
      moderator: KPI_RULES.moderator.update,
      departmentAuthor: KPI_RULES.departmentAuthor.update,
    },
  },
} as const satisfies WriteAllowlist;

/**
 * Every attribute of the authored types (the five phase-1 types, wiki
 * pages and wiki spaces) that NO class may write, with the reason (§B1.7
 * attribute coverage). write-allowlist.test.ts walks each schema: an
 * attribute is either a field of some class's rule or listed here, never
 * both, so a new schema attribute fails the test until it is reviewed. The
 * core validator no longer runs on these routes.
 */
export const REFUSED_ATTRIBUTES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [COURSE_UID]: {
    slug: "derived from title on create; fixed afterwards",
    lessons: "inverse relation: a lesson names its course",
    audience: "derived targeting flag (derivedFromMerged, contract K10)",
    scheduleError: "scheduler bookkeeping",
  },
  [LESSON_UID]: { scheduleError: "scheduler bookkeeping" },
  [DEPARTMENT_UID]: {
    slug: "derived from name on create; fixed afterwards",
    members: "inverse relation: a user names their department",
    teams: "inverse relation: a team names its department",
    pages: "inverse relation: a wiki page names its department",
  },
  [TEAM_UID]: {
    slug: "derived from name on create; fixed afterwards",
    pages: "inverse relation: a wiki page names its team",
  },
  [ANNOUNCEMENT_UID]: {
    author: "ownership: the caller, set on create (callerFields)",
    audience: "derived targeting flag (derivedFromMerged, contract K10)",
    retargetRequired: "derived targeting flag: raised by the delete hooks, lowered by a re-target",
    ownerDepartment: "derived ownership: the department author's department, set on create",
    scheduleError: "scheduler bookkeeping (§D rule 7)",
  },
  [EVENT_UID]: {
    organizer: "ownership: the caller, set on create (callerFields)",
    notifyAudience: "derived targeting flag (derivedFromMerged, contract K10)",
    ownerDepartment: "derived ownership: the department author's department, set on create",
    scheduleError: "scheduler bookkeeping (§D rule 7)",
  },
  [QUICK_LINK_UID]: {
    audience: "derived targeting flag (derivedFromMerged, contract K10)",
    scheduleError: "scheduler bookkeeping (§D rule 7)",
  },
  [DOCUMENT_UID]: {
    audience: "derived targeting flag (derivedFromMerged, contract K10)",
    uploadedBy: "ownership: the caller, set on create (callerFields)",
    ownerDepartment: "derived ownership: the department author's department, set on create",
    scheduleError: "scheduler bookkeeping (§D rule 7)",
  },
  [POLL_UID]: {
    audience: "derived targeting flag (derivedFromMerged, contract K10)",
    author: "ownership: the caller, set on create (callerFields)",
    votersRemovedAt:
      "the retention's terminal mark (v0.28, utils/poll-voter-retention.ts); dropped from every Document Service write by the poll guard",
  },
  [DUTY_PLAN_UID]: {
    author: "ownership: the caller, set on create (callerFields)",
    ownerDepartment:
      "derived ownership: the department author's department on create, a moderator's department",
  },
  [KPI_UID]: {
    author: "ownership: the caller, set on create (callerFields)",
    ownerDepartment:
      "derived ownership: the department author's department on create, a moderator's department",
  },
  [WIKI_PAGE_UID]: {
    slug: "derived from the title on create (uniqueSlugFrom); fixed afterwards",
    children: "inverse side of `parent`: a page names its own parent",
    revisions: "the history: written by the wiki-page lifecycle, read through the history actions",
    author: "ownership: the caller, set on create (callerFields)",
    lastEditor: "the caller of every save (callerFields)",
    scheduleError: "scheduler bookkeeping (§D rule 7)",
  },
  [WIKI_SPACE_UID]: {
    slug: "derived from the name on create (uniqueSlugFrom); fixed afterwards",
    pages: "inverse side of `wiki-page.space`: a page names its space on create",
  },
};

/** The rule for a caller's class, or undefined when the class may not write. */
export function writeRuleFor(
  uid: string,
  action: WriteAction,
  roleClass: string,
): WriteRule | undefined {
  const byClass = (WRITE_ALLOWLIST as WriteAllowlist)[uid]?.[action];
  return byClass && hasOwn(byClass, roleClass) ? byClass[roleClass] : undefined;
}

/** The role classes that have a rule for (uid, action). */
export function writeClassesFor(uid: string, action: WriteAction): string[] {
  return Object.keys((WRITE_ALLOWLIST as WriteAllowlist)[uid]?.[action] ?? {}).sort();
}

// ---------------------------------------------------------------------------
// Relation input
// ---------------------------------------------------------------------------

export type RelationRef = { id: number } | { documentId: string };

/** A to-one relation payload, reduced to what it would do. */
export interface ToOneRelationInput {
  /** The row it should point at afterwards: null = clear, undefined = unchanged. */
  target: RelationRef | null | undefined;
  /** Rows named for disconnection only. */
  disconnect: RelationRef[];
}

/** The same, after a check resolved and authorized every row to a documentId. */
export interface ResolvedToOne {
  target: string | null | undefined;
  disconnect: string[];
}

/**
 * Resolves and authorizes every row a relation input names. Returns null to
 * refuse the field (with the generic message). `resolved` holds the relation
 * fields checked before this one, in rule order.
 */
export type RelationCheck = (
  input: ToOneRelationInput,
  resolved: Readonly<Record<string, ResolvedToOne>>,
) => Promise<ResolvedToOne | null>;

/** Resolves a to-many list to documentIds, or null to refuse the field. */
export type RelationListCheck = (refs: RelationRef[]) => Promise<string[] | null>;

/** Resolves role types to users-permissions role documentIds, or null to refuse. */
export type RoleTypesCheck = (types: string[]) => Promise<string[] | null>;

/** Authorizes a media file id (a newly attached file), or null to refuse the field. */
export type MediaCheck = (fileId: number, field: string) => Promise<number | null>;

/** Answers whether the frozen-field condition holds (a poll has votes). */
export type FrozenCheck = () => Promise<boolean>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hasOwn<T extends object>(object: T, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Strapi resolves a string by `parseInt` (map-relation.js isNumeric): "12"
 * and "12abc" both become row ids. Only canonical forms are accepted here:
 * a positive decimal id within the int4 range of the id columns (a larger
 * one made the Postgres lookup fail with a 500, utils/entry-id.ts), or a
 * documentId that parseInt cannot read as a number (Strapi's generated
 * documentIds start with a letter).
 */
const DOCUMENT_ID = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

function parseRef(value: unknown): RelationRef | null {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    // Longhand: exactly one of id/documentId. position, locale, status,
    // __type ... have no meaning on these relations and are refused.
    if (keys.length !== 1) return null;
    if (keys[0] === "id") {
      const id = parseRowId(value.id);
      return id === null ? null : { id };
    }
    if (keys[0] === "documentId") {
      return isString(value.documentId) && DOCUMENT_ID.test(value.documentId)
        ? { documentId: value.documentId }
        : null;
    }
    return null;
  }
  const id = parseRowId(value);
  if (id !== null) return { id };
  return isString(value) && DOCUMENT_ID.test(value) ? { documentId: value } : null;
}

/** A single ref or a flat array of refs (Strapi's `toArray`). */
function parseRefList(value: unknown): RelationRef[] | null {
  const items: unknown[] = Array.isArray(value) ? value : [value];
  const refs: RelationRef[] = [];
  for (const item of items) {
    const ref = parseRef(item);
    if (!ref) return null;
    refs.push(ref);
  }
  return refs;
}

/** set semantics: at most one row, none = clear. */
function fromSet(value: unknown): ToOneRelationInput | null {
  const refs = parseRefList(value);
  if (!refs || refs.length > 1) return null;
  return { target: refs[0] ?? null, disconnect: [] };
}

/**
 * Parses every input shape Strapi accepts for a to-one relation
 * (@strapi/core document-service map-relation.js, @strapi/database
 * entity-manager toAssocs). Returns null for anything malformed or
 * ambiguous: more than one target, `set` mixed with connect/disconnect,
 * `{ set: null }` (a silent no-op in Strapi), nested arrays, unknown keys.
 */
export function parseToOneRelation(value: unknown): ToOneRelationInput | null {
  if (value === null) return { target: null, disconnect: [] };
  if (Array.isArray(value)) return fromSet(value);
  if (isPlainObject(value) && !hasOwn(value, "id") && !hasOwn(value, "documentId")) {
    const keys = Object.keys(value);
    if (keys.includes("set")) return keys.length === 1 ? fromSet(value.set) : null;
    if (keys.length === 0 || keys.some((key) => key !== "connect" && key !== "disconnect")) {
      return null;
    }
    const connect = hasOwn(value, "connect") ? parseRefList(value.connect) : [];
    const disconnect = hasOwn(value, "disconnect") ? parseRefList(value.disconnect) : [];
    if (!connect || !disconnect || connect.length > 1) return null;
    return { target: connect[0], disconnect };
  }
  const ref = parseRef(value);
  return ref ? { target: ref, disconnect: [] } : null;
}

/**
 * A to-many payload as a FULL REPLACEMENT (§B1.2 relationList): a list of
 * refs, or `{ set: [...] }`; null and [] clear it. connect/disconnect,
 * nested arrays and more than `max` entries are refused (null).
 */
export function parseRelationList(value: unknown, max: number): RelationRef[] | null {
  if (value === null) return [];
  let list: unknown;
  if (Array.isArray(value)) list = value;
  else if (isPlainObject(value) && Object.keys(value).length === 1 && hasOwn(value, "set")) {
    list = value.set;
  } else return null;
  if (!Array.isArray(list) || list.length > max) return null;
  if (list.length === 0) return [];
  return parseRefList(list);
}

/**
 * A to-many payload as CHANGES (`delta` fields): `{ connect?: refs,
 * disconnect?: refs }`, at most `max` refs together; any other shape, a set
 * or a bare list is refused (null).
 */
export function parseRelationDelta(
  value: unknown,
  max: number,
): { connect: RelationRef[]; disconnect: RelationRef[] } | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((key) => key === "connect" || key === "disconnect"))
    return null;
  const listOf = (raw: unknown): RelationRef[] | null =>
    raw === undefined
      ? []
      : Array.isArray(raw)
        ? raw.length === 0
          ? []
          : parseRefList(raw)
        : null;
  const connect = listOf(value.connect);
  const disconnect = listOf(value.disconnect);
  if (!connect || !disconnect || connect.length + disconnect.length > max) return null;
  return { connect, disconnect };
}

/** Role types as a list of distinct strings (no shape but a flat list or null). */
function parseRoleTypes(value: unknown, field: RoleTypesField): string[] | null {
  if (value === null) return [];
  if (!Array.isArray(value) || value.length > field.max) return null;
  const types: string[] = [];
  for (const item of value as unknown[]) {
    if (!isString(item) || !(field.allowed as readonly string[]).includes(item)) return null;
    if (!types.includes(item)) types.push(item);
  }
  return types;
}

/** A media value: a file row id, `{ id }`, or null to clear. */
function parseMedia(value: unknown): number | null | undefined {
  if (value === null) return null;
  const id = parseRowId(isPlainObject(value) && Object.keys(value).length === 1 ? value.id : value);
  return id === null ? undefined : id;
}

/** Marker: the field is a no-op and is left out of the payload. */
const OMIT = Symbol("omit");

/** Back to a Strapi relation payload that names documents only. */
function toStrapiRelation(resolved: ResolvedToOne): unknown {
  if (resolved.target === null) return null;
  if (resolved.target !== undefined) return { set: [{ documentId: resolved.target }] };
  if (resolved.disconnect.length > 0) {
    return { disconnect: resolved.disconnect.map((documentId) => ({ documentId })) };
  }
  return OMIT;
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/** The core controller's own message for a missing or non-object `data`. */
export const MISSING_DATA_MESSAGE = 'Missing "data" payload in the request body';

/** The one message for every refused key or value. */
export function writeAllowlistMessage(keys: readonly string[]): string {
  return `Invalid or disallowed data field(s): ${keys.join(", ")}`;
}

/**
 * The generic 400: every refused key in `details.keys` (sorted) and, when
 * any refusal has a reason, `details.codes` for those keys.
 */
export function refuseKeys(
  keys: Iterable<string>,
  codes: Readonly<Partial<Record<string, string>>> = {},
): never {
  const sorted = [...new Set(keys)].sort();
  const known = Object.fromEntries(
    sorted.filter((key) => typeof codes[key] === "string").map((key) => [key, codes[key]]),
  );
  throw new errors.ValidationError(
    writeAllowlistMessage(sorted),
    Object.keys(known).length > 0 ? { keys: sorted, codes: known } : { keys: sorted },
  );
}

export interface WriteRuleEnvironment {
  callerId: number;
  /** create or update (callerDepartment defaults and derivedOnCreate run on create). */
  action?: WriteAction;
  relationChecks?: Readonly<Partial<Record<AnyRelationCheckName, RelationCheck>>>;
  relationListChecks?: Readonly<Partial<Record<RelationListCheckName, RelationListCheck>>>;
  roleTypesCheck?: RoleTypesCheck;
  mediaChecks?: Readonly<Partial<Record<MediaCheckName, MediaCheck>>>;
  frozenChecks?: Readonly<Partial<Record<FrozenCheckName, FrozenCheck>>>;
  /**
   * The stored draft an update changes, normalised (relations as
   * documentIds, audience roles as role types, instants as ISO-Z): the
   * base of crossCheck and derivedFromMerged. Null on create.
   */
  existing?: Readonly<Record<string, unknown>> | null;
  /** The published twin, normalised like `existing` (frozenWhen compares against it). */
  published?: Readonly<Record<string, unknown>> | null;
  /** The department author's department (callerDepartment, ownerDepartment). */
  callerDepartment?: { id: number; documentId: string } | null;
  /** Early publish readiness: the keys that block publishing `merged`. */
  readiness?: (merged: Readonly<Record<string, unknown>>) => Promise<string[]>;
  /** The clock of the schedule check (ms). */
  now?: number;
}

/** A check a rule names but the policy did not supply: a wiring bug (500, fail closed). */
function missingCheck(kind: string, name: string): never {
  throw new Error(`write allowlist: ${kind} check "${name}" not supplied`);
}

/** The value a check answered, as "accepted", "refused" or the refusal code. */
function verdict(result: boolean | string | null): { ok: boolean; code?: string } {
  if (result === true || result === null) return { ok: true };
  if (result === false) return { ok: false };
  return { ok: false, code: result };
}

/**
 * Checks `data` against `rule` and returns the payload to hand to the
 * Document Service: the accepted values, the rewritten relations, the
 * derived fields and the caller fields. Throws a ValidationError (400)
 * naming every refused key (see refuseKeys). Keys and plain values are
 * checked before any relation is looked up, so a refused key never costs
 * (or reveals) a database lookup.
 */
export async function applyWriteRule(
  data: unknown,
  rule: WriteRule,
  env: WriteRuleEnvironment,
): Promise<Record<string, unknown>> {
  if (!isPlainObject(data)) throw new errors.ValidationError(MISSING_DATA_MESSAGE);
  const action = env.action ?? "update";

  // callerDepartment on create (§N4): a missing key is the caller's department.
  const payload: Record<string, unknown> = { ...data };
  if (action === "create") {
    for (const [key, spec] of Object.entries(rule.fields)) {
      if (hasOwn(payload, key)) continue;
      const pinned =
        (spec.kind === "relation" || spec.kind === "relationList") &&
        spec.callerDepartmentOnCreate === true;
      if (!pinned) continue;
      const department = env.callerDepartment;
      if (!department) missingCheck("caller department", key);
      payload[key] = spec.kind === "relation" ? department.documentId : [department.documentId];
    }
  }

  const refused = new Set<string>();
  const codes: Partial<Record<string, string>> = {};
  const out: Record<string, unknown> = {};
  /** The accepted values as crossCheck/derivedFromMerged read them. */
  const mergedPart: Record<string, unknown> = {};
  const relationInputs = new Map<string, ToOneRelationInput>();
  const listInputs = new Map<string, RelationRef[]>();
  const deltaInputs = new Map<string, { connect: RelationRef[]; disconnect: RelationRef[] }>();
  const roleInputs = new Map<string, string[]>();
  const mediaInputs = new Map<string, number | null>();
  const frozenCandidates: string[] = [];

  for (const [key, raw] of Object.entries(payload)) {
    const spec = hasOwn(rule.fields, key) ? rule.fields[key] : undefined;
    if (!spec) {
      refused.add(key);
    } else if (spec.kind === "relation") {
      const parsed = parseToOneRelation(raw);
      const singleTarget = parsed?.target != null && parsed.disconnect.length === 0;
      if (!parsed || (spec.required && !singleTarget)) refused.add(key);
      else relationInputs.set(key, parsed);
    } else if (spec.kind === "relationList" && spec.delta) {
      const changes = parseRelationDelta(raw, spec.max);
      if (!changes) refused.add(key);
      else deltaInputs.set(key, changes);
    } else if (spec.kind === "relationList") {
      const refs = parseRelationList(raw, spec.max);
      if (!refs) refused.add(key);
      else listInputs.set(key, refs);
    } else if (spec.kind === "roleTypes") {
      const types = parseRoleTypes(raw, spec);
      if (!types) refused.add(key);
      else roleInputs.set(key, types);
    } else if (spec.kind === "media") {
      const fileId = parseMedia(raw);
      if (fileId === undefined) refused.add(key);
      else mediaInputs.set(key, fileId);
    } else {
      const { ok, code } = verdict(spec.check(raw));
      if (ok) {
        out[key] = raw;
        mergedPart[key] = raw;
        if (spec.kind === "value" && spec.frozenWhen) frozenCandidates.push(key);
      } else {
        refused.add(key);
        if (code) codes[key] = code;
      }
    }
  }
  for (const [key, spec] of Object.entries(rule.fields)) {
    if (spec.kind === "relation" && spec.required && !hasOwn(payload, key)) refused.add(key);
  }
  if (refused.size > 0) refuseKeys(refused, codes);

  // To-one relations, in rule order; the first refusal answers alone.
  const resolved: Record<string, ResolvedToOne> = {};
  /** Relation keys whose input named no target (a no-op): not a re-target. */
  const noTarget = new Set<string>();
  for (const [key, spec] of Object.entries(rule.fields)) {
    const input = relationInputs.get(key);
    if (spec.kind !== "relation" || !input) continue;
    const check = env.relationChecks?.[spec.check];
    // A rule naming a check its policy does not supply is a wiring bug:
    // fail the request (500) instead of writing an unchecked relation.
    if (!check) missingCheck("relation", spec.check);
    const result = await check(input, resolved);
    if (!result) refuseKeys([key]);
    resolved[key] = result;
    const relation = toStrapiRelation(result);
    if (relation !== OMIT) out[key] = relation;
    if (result.target !== undefined) mergedPart[key] = result.target;
    else noTarget.add(key);
  }

  // To-many lists (full replacement), role types and media.
  for (const [key, refs] of listInputs) {
    const spec = rule.fields[key] as RelationListField;
    const check = env.relationListChecks?.[spec.check];
    if (!check) missingCheck("relation list", spec.check);
    // An empty list still goes through the check: callerDepartments refuses it.
    const documentIds = await check(refs);
    if (!documentIds) refuseKeys([key]);
    out[key] = { set: documentIds.map((documentId) => ({ documentId })) };
    mergedPart[key] = documentIds;
  }
  // Changes (no merged value: no rule derives anything from a delta field).
  for (const [key, changes] of deltaInputs) {
    const spec = rule.fields[key] as RelationListField;
    const check = env.relationListChecks?.[spec.check];
    if (!check) missingCheck("relation list", spec.check);
    const connect = await check(changes.connect);
    const disconnect = await check(changes.disconnect);
    // One target on both sides says nothing clear: refused like any other bad value.
    if (!connect || !disconnect || connect.some((id) => disconnect.includes(id))) refuseKeys([key]);
    out[key] = {
      connect: connect.map((documentId) => ({ documentId })),
      disconnect: disconnect.map((documentId) => ({ documentId })),
    };
  }
  for (const [key, types] of roleInputs) {
    let documentIds: string[] | null = [];
    if (types.length > 0) {
      if (!env.roleTypesCheck) missingCheck("role types", key);
      documentIds = await env.roleTypesCheck(types);
    }
    if (!documentIds) refuseKeys([key]);
    out[key] = { set: documentIds.map((documentId) => ({ documentId })) };
    mergedPart[key] = types;
  }
  for (const [key, fileId] of mediaInputs) {
    const spec = rule.fields[key] as MediaField;
    if (fileId === null) {
      out[key] = null;
      mergedPart[key] = null;
      continue;
    }
    // Retain: the stored draft's current file passes unchecked (§E2).
    const current = env.existing?.[key];
    const currentId = isPlainObject(current) ? current.id : current;
    let authorized: number | null = fileId;
    if (currentId !== fileId) {
      const check = env.mediaChecks?.[spec.check];
      if (!check) missingCheck("media", spec.check);
      authorized = await check(fileId, key);
    }
    if (authorized === null) refuseKeys([key]);
    out[key] = authorized;
    mergedPart[key] = authorized;
  }

  // frozenWhen: a change against the PUBLISHED row once a vote exists.
  const changedFrozen = frozenCandidates.filter((key) => {
    const spec = rule.fields[key] as ValueField;
    const published = env.published;
    return published != null && !spec.frozenWhen?.same(out[key], published[key]);
  });
  if (changedFrozen.length > 0) {
    const name = (rule.fields[changedFrozen[0]] as ValueField).frozenWhen?.check ?? "pollHasVotes";
    const check = env.frozenChecks?.[name];
    if (!check) missingCheck("frozen", name);
    if (await check()) {
      refuseKeys(
        changedFrozen,
        Object.fromEntries(changedFrozen.map((key) => [key, "frozenAfterVotes"])),
      );
    }
  }

  // What the payload explicitly sets. A relation shape that names no
  // target (a disconnect, `{ connect: [] }`) does not say where the item
  // points, so it never counts as a re-target (contract K10).
  const carried = new Set(Object.keys(payload).filter((key) => !noTarget.has(key)));
  const merged: Record<string, unknown> = { ...(env.existing ?? {}), ...mergedPart };
  if (rule.crossCheck) {
    const crossCodes = rule.crossCheck(merged, carried, env);
    const keys = Object.keys(crossCodes).filter((key) => crossCodes[key] !== undefined);
    if (keys.length > 0) refuseKeys(keys, crossCodes);
  }
  const accepted = { ...out };
  const derived = Object.fromEntries(
    Object.entries(rule.derivedFields ?? {}).map(([field, derive]) => [field, derive(accepted)]),
  );
  if (
    rule.readinessWhenScheduled &&
    carried.has("publishAt") &&
    merged.publishAt !== null &&
    merged.publishAt !== undefined
  ) {
    if (!env.readiness) missingCheck("readiness", "publishBlockers");
    // The derived values are part of what will be stored (a wiki page's
    // required slug on create).
    const blockers = await env.readiness({ ...merged, ...derived });
    if (blockers.length > 0) {
      refuseKeys(blockers, Object.fromEntries(blockers.map((key) => [key, "notPublishable"])));
    }
  }

  Object.assign(out, derived);
  for (const [field, derivation] of Object.entries(rule.derivedFromMerged ?? {})) {
    if (carriesAny(carried, derivation.when)) out[field] = derivation.derive(merged);
  }
  if (action === "create") {
    for (const [field, derive] of Object.entries(rule.derivedOnCreate ?? {})) {
      out[field] = derive(env);
    }
  }
  for (const field of rule.callerFields ?? []) out[field] = env.callerId;
  return out;
}

/** The slice of the Strapi policy context the enforcement reads and writes. */
export interface WritePolicyContext {
  /** Koa's ctx.request, shared with the controller (policy-query.ts). */
  request?: { body?: unknown; query?: Record<string, unknown> };
}

export interface EnforceOptions {
  /**
   * "pin" (default, the FX07 gates): the write is pinned to
   * `status=published` on the real query. "controller": the authoring
   * controller decides the status itself and refuses every other query
   * key (global::can-author).
   */
  status?: "pin" | "controller";
}

/**
 * The single enforcement point for a write route: looks up the rule for
 * the caller's class, pins the write to `status=published` (FX07 gates; see
 * EnforceOptions), checks `request.body.data` and replaces it with the
 * sanitized payload. Resolves false when the class has no rule (the policy
 * returns that, i.e. 403); throws a ValidationError (400) on a refused
 * payload; resolves true otherwise. Call it only AFTER the row gate.
 */
export async function enforceWriteAllowlist(
  policyContext: WritePolicyContext,
  target: { uid: string; action: WriteAction; roleClass: string },
  env: WriteRuleEnvironment,
  options: EnforceOptions = {},
): Promise<boolean> {
  const rule = writeRuleFor(target.uid, target.action, target.roleClass);
  if (!rule) return false;
  // The REAL query the controller reads, not a policy-context copy (§5.14).
  if (options.status !== "controller") forcePublishedStatus(getMutableQuery(policyContext));
  const body = policyContext.request?.body;
  if (!isPlainObject(body)) throw new errors.ValidationError(MISSING_DATA_MESSAGE);
  body.data = await applyWriteRule(body.data, rule, { ...env, action: target.action });
  return true;
}

// ---------------------------------------------------------------------------
// What the write policies share
// ---------------------------------------------------------------------------

export const USER_UID = "plugin::users-permissions.user";

/** The authenticated caller as users-permissions puts it on ctx.state. */
export interface WriteCaller {
  id: number;
  role?: { type?: string } | null;
}

/** The slice of the Strapi policy context a write policy reads and writes. */
export interface WritePolicy extends WritePolicyContext {
  state?: { user?: WriteCaller | null };
  params?: { id?: unknown };
}

/** The slice of `strapi` the write policies and their checks use. */
export interface StrapiDbQuery {
  findOne(params: object): Promise<unknown>;
  findMany(params: object): Promise<unknown>;
}

export interface StrapiDb {
  db: { query(uid: string): StrapiDbQuery };
}

/** Whether a write route names a target row at all (update routes do, create routes do not). */
export function hasTargetId(idParam: unknown): boolean {
  return idParam !== undefined && idParam !== null && idParam !== "";
}

/**
 * The `where` for the row a write route targets, as the policy looks it up.
 * v5 routes carry a documentId; a numeric row id is accepted here too. Both
 * follow the relation refs above: a row id within the int4 range, or a
 * documentId parseInt cannot read. null = no usable target: no id at all,
 * or a malformed or out-of-range one. The policies refuse the latter like
 * an unknown row, and it never reaches the query (a row id beyond int4 made
 * the Postgres lookup fail with a 500, utils/entry-id.ts).
 *
 * Accepting a numeric id in the POLICY does not make the route take one:
 * the v5 core update resolves documentIds only. The department and team
 * controllers translate a numeric id to the documentId before the core
 * update (PL01); the wiki-page update does not, so a numeric id passes
 * can-edit-wiki and the core update then answers 404. The authoring
 * controller translates it through the canonical draft loader
 * (utils/write-gate.ts).
 *
 * Why this is not parseEntryRef (utils/entry-id.ts), which every other
 * id-addressed policy and controller uses (PL01 reconciliation): row ids
 * follow ONE rule in both (parseRowId: canonical decimal within int4, the
 * only values that could fail a Postgres lookup), so both refuse exactly
 * the same numeric-looking values. They differ only in how early a
 * documentId that Strapi never generates is refused. parseEntryRef takes
 * Strapi's own shape (cuid2, 24 characters) and answers anything else
 * before a query; this function reads the route id with the relation-ref
 * rule of the payloads above, which must accept what Strapi's relation
 * input accepts, and lets the lookup find nothing for such a value (a
 * varchar comparison never fails). Every id parseEntryRef accepts, this
 * accepts with the same result (write-allowlist.test.ts pins the subset);
 * the outcome for the wider rest is the same refusal, one query later.
 * The FX07 gates keep it so a route id and a payload ref of the same row
 * are read alike.
 */
export function targetRowWhere(idParam: unknown): RelationRef | null {
  if (!hasTargetId(idParam)) return null;
  return parseRef(String(idParam));
}
