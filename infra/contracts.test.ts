import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  isAnnouncementVisibleTo,
  type AnnouncementAudience,
  type AudienceScope,
} from "../apps/web/src/lib/audience";
import { AD_CATEGORIES, AD_CATEGORY_KEYS } from "../apps/web/src/lib/classified-shared";
import {
  anchorOf,
  type CommentTargetType as WebCommentTargetType,
} from "../apps/web/src/lib/comment-target";
import { NO_GUEST_ACCESS, normalizeGuestAccess } from "../apps/web/src/lib/poll-guest-access";
import { ALL_EMOJIS } from "../apps/web/src/lib/reaction-summary";
import * as webRoles from "../apps/web/src/lib/roles";
import { youtubeVideoId as webYoutubeVideoId } from "../apps/web/src/lib/training-shared";
import type {
  Acknowledgement,
  ClassifiedCategory,
  Comment,
  Course,
  Document,
  EmojiType,
  KudosValue,
  Notification,
  Poll,
  PollResults,
  Reaction,
  RsvpStatus,
  WikiSpace,
} from "../apps/web/src/lib/types";

/**
 * Cross-app contract (roadmap S05): the cms and the web are separate Docker
 * build contexts, so every rule both apps apply exists twice, and the web's
 * types and constants restate the cms schemas by hand. This root suite pins
 * the pairs to each other:
 *
 *   1. the announcement audience (cms utils/announcement-audience.ts, the
 *      policy; web lib/audience.ts, the ack report): a decision table plus a
 *      seeded fuzz that must agree case by case;
 *   2. youtubeVideoId (cms training-validation.ts, author feedback; web
 *      training-shared.ts, the AUTHORITATIVE render gate) over the union of
 *      both suites' corpora plus a seeded fuzz;
 *   3. comment/reaction anchor normalisation (targetAnchor vs anchorOf);
 *   4. schema.json enums against the web unions and constants (types.ts,
 *      AD_CATEGORIES, ALL_EMOJIS, the kudos form values, the RSVP statuses,
 *      the quick-link CATEGORY_ORDER, the live CHANNEL_RE, poll audience and
 *      the guest flags). A web union is pinned in two halves: its
 *      hand-written unionValues list is checked against the union at COMPILE
 *      time only, by `pnpm typecheck` (the typecheck:tests step,
 *      tsconfig.test.json; CI's build job runs it), not by `pnpm test`, which
 *      strips types; `pnpm test` compares that list with the schema at run
 *      time. So a web union change needs `pnpm typecheck`, a schema enum
 *      change `pnpm test`, and CI runs both. The constants read from source
 *      (event-actions STATUSES, give-kudos VALUES) and the exported ones are
 *      compared with the schema at run time;
 *   5. every mappedBy has its inversedBy and back (KNOWN gaps listed);
 *   6. the web role sets against PERMISSION_MATRIX / CUSTOM_ACTION_GRANTS
 *      (KNOWN gaps listed until SH02).
 * Constants a module does not export are read from the source file; a
 * declaration that moves fails loudly, and the move updates this file.
 * A KNOWN gap is asserted as it is today, so closing it fails here too and
 * the closing change removes the entry. The README permission table is
 * DO03's.
 *
 * The cms modules are loaded at run time through `cms()`, typed by the
 * facades below: this file is type-checked by the STRICT web/infra program
 * (tsconfig.test.json), and a static import would pull src/index.ts and its
 * whole import graph into it, holding cms code to rules its own typecheck
 * (tsconfig.test.cms.json, S07) does not apply.
 */

const ROOT = join(__dirname, "..");
const CMS_SRC = join(ROOT, "apps", "cms", "src");

/** A cms module, loaded at run time (see the header). */
async function cms<T>(relative: string): Promise<T> {
  return (await import(join(CMS_SRC, relative))) as T;
}

type RoleGrants = Record<string, Record<string, readonly string[] | undefined>>;

const { PERMISSION_MATRIX, CUSTOM_ACTION_GRANTS } = await cms<{
  PERMISSION_MATRIX: RoleGrants;
  CUSTOM_ACTION_GRANTS: Record<string, readonly string[] | "*" | undefined>;
}>("bootstrap/permission-matrix.ts");

const { isAnnouncementVisible } = await cms<{
  isAnnouncementVisible(announcement: AnnouncementAudience, scope: AudienceScope | null): boolean;
}>("utils/announcement-audience.ts");

const { TARGET_UIDS, isCommentTargetType, targetAnchor } = await cms<{
  TARGET_UIDS: Record<string, string>;
  isCommentTargetType(value: unknown): boolean;
  targetAnchor(value: unknown): string | null;
}>("utils/comment-target.ts");

interface GuestFlags {
  visibleToGuests?: boolean | null;
  guestsCanVote?: boolean | null;
}

const { POLL_AUDIENCE_ALL, POLL_AUDIENCE_DEPARTMENTS, canGuestsVoteOnPoll, isPollVisibleToGuests } =
  await cms<{
    POLL_AUDIENCE_ALL: string;
    POLL_AUDIENCE_DEPARTMENTS: string;
    canGuestsVoteOnPoll(poll: GuestFlags): boolean;
    isPollVisibleToGuests(poll: GuestFlags): boolean;
  }>("utils/poll-audience.ts");

const { youtubeVideoId: cmsYoutubeVideoId } = await cms<{
  youtubeVideoId(rawUrl: unknown): string | null;
}>("utils/training-validation.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG, so every fuzz run checks the same cases. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, list: readonly T[]): T =>
  list[Math.floor(random() * list.length)];

const subset = <T>(random: () => number, list: readonly T[]): T[] =>
  list.filter(() => random() < 0.4);

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The members of a string union as a list. It compiles only when the list
 * names every member and nothing else, so the web union cannot change
 * without this file. That half is a TYPE check: `pnpm typecheck`
 * (typecheck:tests) enforces it, `pnpm test` does not, because Vitest strips
 * types. The returned list is compared with the schema at run time.
 */
function unionValues<U extends string>() {
  return <const V extends readonly U[]>(
    values: V,
    // Type level only: a list that differs from the union demands this extra
    // argument, so the call does not compile. Nothing is passed at run time.
    ..._mismatch: Exactly<U, V[number]> extends true
      ? []
      : [error: "the list does not match the union"]
  ): readonly string[] => values;
}

const sorted = (values: Iterable<string>) => [...values].sort();

interface AttributeSchema {
  type: string;
  enum?: string[];
  default?: unknown;
  relation?: string;
  target?: string;
  mappedBy?: string;
  inversedBy?: string;
}

interface ContentTypeSchema {
  options?: { draftAndPublish?: boolean };
  attributes: Record<string, AttributeSchema>;
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

/** Every cms content type by uid: api::<api>.<type> and the users-permissions user extension. */
function cmsSchemas(): Record<string, ContentTypeSchema> {
  const schemas: Record<string, ContentTypeSchema> = {};
  const apiDir = join(CMS_SRC, "api");
  for (const api of readdirSync(apiDir)) {
    const typesDir = join(apiDir, api, "content-types");
    if (!existsSync(typesDir)) continue;
    for (const type of readdirSync(typesDir)) {
      const file = join(typesDir, type, "schema.json");
      if (existsSync(file)) schemas[`api::${api}.${type}`] = readJson(file);
    }
  }
  schemas["plugin::users-permissions.user"] = readJson(
    join(CMS_SRC, "extensions", "users-permissions", "content-types", "user", "schema.json"),
  );
  return schemas;
}

/** The users-permissions plugin's own role and permission types (targets of user.role). */
function pluginSchemas(): Record<string, ContentTypeSchema> {
  const requireFromCms = createRequire(join(ROOT, "apps", "cms", "package.json"));
  const pluginDir = dirname(
    requireFromCms.resolve("@strapi/plugin-users-permissions/package.json"),
  );
  const load = (name: string) =>
    (
      requireFromCms(join(pluginDir, "dist", "server", "content-types", name, "index.js")) as {
        __require(): ContentTypeSchema;
      }
    ).__require();
  return {
    "plugin::users-permissions.role": load("role"),
    "plugin::users-permissions.permission": load("permission"),
  };
}

const SCHEMAS = cmsSchemas();

function enumOf(uid: string, attribute: string): string[] {
  const values = SCHEMAS[uid]?.attributes[attribute]?.enum;
  if (!values) throw new Error(`${uid}.${attribute} is not an enumeration`);
  return values;
}

/** The string literals inside the first capture group of `pattern` in a source file. */
function sourceStrings(file: string, pattern: RegExp, literal = /"([^"]*)"/g): string[] {
  const source = readFileSync(join(ROOT, file), "utf8");
  const match = pattern.exec(source);
  if (!match)
    throw new Error(`${file}: ${pattern} not found; update infra/contracts.test.ts with the move`);
  return [...match[1].matchAll(literal)].map((found) => found[1]);
}

// ---------------------------------------------------------------------------
// 1. Announcement audience
// ---------------------------------------------------------------------------

describe("announcement audience: cms announcement-audience.ts = web audience.ts", () => {
  const MEMBER_ROLE = 5;
  const GUEST_ROLE = 6;
  const scope = (
    departmentId: number | null,
    teamIds: number[],
    roleId: number | null,
  ): AudienceScope => ({
    departmentId,
    teamIds,
    roleId,
  });

  const TABLE: Array<[string, AnnouncementAudience, AudienceScope | null, boolean]> = [
    ["untargeted, anonymous", {}, null, true],
    ["untargeted, any caller", { audience: "all" }, scope(11, [], GUEST_ROLE), true],
    [
      "audience 'departments' without a department link stays company-wide",
      { audience: "departments" },
      scope(11, [], 1),
      true,
    ],
    ["department, anonymous", { department: { id: 10 } }, null, false],
    ["department, member of it", { department: { id: 10 } }, scope(10, [], MEMBER_ROLE), true],
    [
      "department, member of another",
      { department: { id: 10 } },
      scope(11, [], MEMBER_ROLE),
      false,
    ],
    [
      "department, caller without one",
      { department: { id: 10 } },
      scope(null, [], MEMBER_ROLE),
      false,
    ],
    [
      "a department restricts even with audience 'all'",
      { audience: "all", department: { id: 10 } },
      scope(11, [], 1),
      false,
    ],
    ["team, member or lead", { team: { id: 30 } }, scope(null, [30], MEMBER_ROLE), true],
    ["team, outsider", { team: { id: 30 } }, scope(10, [31], MEMBER_ROLE), false],
    ["team, anonymous", { team: { id: 30 } }, null, false],
    ["roles, holder", { audienceRoles: [{ id: MEMBER_ROLE }] }, scope(null, [], MEMBER_ROLE), true],
    [
      "roles, other role",
      { audienceRoles: [{ id: MEMBER_ROLE }] },
      scope(10, [30], GUEST_ROLE),
      false,
    ],
    [
      "roles, caller without a role",
      { audienceRoles: [{ id: MEMBER_ROLE }] },
      scope(10, [30], null),
      false,
    ],
    ["roles, anonymous", { audienceRoles: [{ id: MEMBER_ROLE }] }, null, false],
    ["an empty role list does not restrict", { audienceRoles: [] }, scope(null, [], null), true],
    [
      "department AND team: team missing",
      { department: { id: 10 }, team: { id: 30 } },
      scope(10, [], 5),
      false,
    ],
    [
      "department AND team: both",
      { department: { id: 10 }, team: { id: 30 } },
      scope(10, [30], 5),
      true,
    ],
    [
      "all three criteria met",
      { department: { id: 10 }, team: { id: 30 }, audienceRoles: [{ id: 5 }, { id: 6 }] },
      scope(10, [30], 6),
      true,
    ],
    [
      "all three criteria, role missing",
      { department: { id: 10 }, team: { id: 30 }, audienceRoles: [{ id: 5 }] },
      scope(10, [30], 6),
      false,
    ],
    [
      "null relations count as unset",
      { department: null, team: null, audienceRoles: null },
      null,
      true,
    ],
  ];

  it.each(TABLE)("%s", (_label, announcement, callerScope, expected) => {
    expect(isAnnouncementVisible(announcement, callerScope)).toBe(expected);
    expect(isAnnouncementVisibleTo(announcement, callerScope)).toBe(expected);
  });

  it("agrees on 5000 seeded random announcements and scopes", () => {
    const random = prng(0x5eed);
    const ids = [1, 2, 3];
    const outcomes = new Set<boolean>();
    for (let i = 0; i < 5000; i += 1) {
      const announcement: AnnouncementAudience = {
        audience: pick(random, ["all", "departments", null, undefined]),
        department: random() < 0.5 ? null : { id: pick(random, ids) },
        team: random() < 0.5 ? null : { id: pick(random, ids) },
        audienceRoles: random() < 0.3 ? null : subset(random, [1, 2, 3, 4]).map((id) => ({ id })),
      };
      const callerScope =
        random() < 0.15
          ? null
          : {
              roleId: random() < 0.2 ? null : pick(random, [1, 2, 3, 4]),
              departmentId: random() < 0.2 ? null : pick(random, ids),
              teamIds: subset(random, ids),
            };
      const cms = isAnnouncementVisible(announcement, callerScope);
      expect(
        isAnnouncementVisibleTo(announcement, callerScope),
        JSON.stringify({ announcement, callerScope }),
      ).toBe(cms);
      outcomes.add(cms);
    }
    expect(outcomes).toEqual(new Set([true, false]));
  });
});

// ---------------------------------------------------------------------------
// 2. youtubeVideoId
// ---------------------------------------------------------------------------

describe("youtubeVideoId: cms training-validation.ts = web training-shared.ts", () => {
  const ID = "dQw4w9WgXcQ";
  /** Both suites' corpora (training-validation.test.ts, training-shared.test.ts) plus edge cases. */
  const CORPUS: Array<[unknown, string | null]> = [
    [`https://www.youtube.com/watch?v=${ID}`, ID],
    [`https://youtu.be/${ID}`, ID],
    [`https://youtu.be/${ID}?t=42`, ID],
    [`https://www.youtube-nocookie.com/embed/${ID}`, ID],
    [`https://m.youtube.com/watch?v=${ID}`, ID],
    [`https://www.youtube.com/shorts/${ID}`, ID],
    [`  https://www.youtube.com/watch?v=${ID}  `, ID],
    [`http://www.youtube.com/watch?v=${ID}`, null],
    [`https://evil.example/watch?v=${ID}`, null],
    [`https://www.youtube.com.evil.example/watch?v=${ID}`, null],
    ["https://www.youtube.com/watch?v=<script>", null],
    ["https://www.youtube.com/watch?v=short", null],
    ["javascript:alert(1)", null],
    ["https://vimeo.com/12345678", null],
    ["https://vimeo.com/123", null],
    ["", null],
    [null, null],
    [42, null],
    // Edge cases beyond both suites.
    [`https://www.youtube.com/live/${ID}`, ID],
    [`https://www.youtube.com/embed/${ID}?start=30`, ID],
    [`https://youtube.com/watch?v=${ID}&t=1s`, ID],
    [`https://WWW.YOUTUBE.COM/watch?v=${ID}`, ID],
    [`https://www.youtube.com:443/watch?v=${ID}`, ID],
    [`https://www.youtube-nocookie.com/watch?v=${ID}`, ID],
    [`https://youtu.be/${ID}/extra`, ID],
    [`https://www.youtube.com/watch?v=${ID}x`, null],
    ["https://www.youtube.com/playlist?list=PL0123456789", null],
    ["https://youtu.be/", null],
    ["https://www.youtube.com/embed/", null],
    [`//www.youtube.com/watch?v=${ID}`, null],
    [`https://music.youtube.com/watch?v=${ID}`, null],
    [`javascript:alert(1)//https://www.youtube.com/watch?v=${ID}`, null],
    [`data:text/html,https://youtu.be/${ID}`, null],
    ["   ", null],
    [undefined, null],
    [{}, null],
    [[`https://youtu.be/${ID}`], null],
  ];

  it.each(CORPUS)("%s -> %s", (url, expected) => {
    expect(cmsYoutubeVideoId(url)).toBe(expected);
    expect(webYoutubeVideoId(url)).toBe(expected);
  });

  it("agrees on 3000 seeded random URLs", () => {
    const random = prng(0x7a1e);
    const schemes = ["https://", "http://", "HTTPS://", "", "//", "javascript:"];
    const hosts = [
      "www.youtube.com",
      "youtube.com",
      "m.youtube.com",
      "www.youtube-nocookie.com",
      "youtu.be",
      "evil.example",
      "www.youtube.com.evil.example",
      "music.youtube.com",
    ];
    const alphabet = "abcXYZ019_-<>\"'% /?&=#";
    const randomId = () => {
      const length = pick(random, [0, 10, 11, 11, 11, 12]);
      return Array.from({ length }, () => pick(random, [...alphabet, ...ID])).join("");
    };
    const paths = [
      () => `/watch?v=${randomId()}`,
      () => `/${randomId()}`,
      () => `/embed/${randomId()}`,
      () => `/shorts/${randomId()}`,
      () => `/live/${randomId()}`,
      () => `/watch?x=1&v=${randomId()}`,
      () => `/playlist?list=${randomId()}`,
    ];
    const accepted = new Set<boolean>();
    for (let i = 0; i < 3000; i += 1) {
      const url = `${pick(random, schemes)}${pick(random, hosts)}${pick(random, paths)()}`;
      const cms = cmsYoutubeVideoId(url);
      expect(webYoutubeVideoId(url), url).toBe(cms);
      accepted.add(cms !== null);
    }
    expect(accepted).toEqual(new Set([true, false]));
  });
});

// ---------------------------------------------------------------------------
// 3. Comment / reaction anchors
// ---------------------------------------------------------------------------

describe("comment/reaction anchors: cms targetAnchor = web anchorOf", () => {
  const VALUES: unknown[] = [
    "k3m9x0000000000000000000",
    " k3m9x0000000000000000000 ",
    "\tabc\n",
    " abc ",
    "",
    "   ",
    " ",
    null,
    undefined,
    0,
    1,
    true,
    {},
    [],
    ["abc"],
    { documentId: "abc" },
  ];

  it.each(VALUES)("%j", (value) => {
    expect(anchorOf(value)).toBe(targetAnchor(value));
  });

  it("both apps know the same target types, and they are the schema's", () => {
    const web = unionValues<WebCommentTargetType>()(["announcement", "wiki-page"]);
    expect(sorted(Object.keys(TARGET_UIDS))).toEqual(sorted(web));
    for (const uid of ["api::comment.comment", "api::reaction.reaction"]) {
      expect(sorted(enumOf(uid, "targetType")), uid).toEqual(sorted(web));
    }
    for (const type of web) expect(isCommentTargetType(type), type).toBe(true);
    // Plain non-members only; prototype keys are pinned in comment-target.test.ts (FX27).
    for (const type of ["document", "Announcement", "wiki_page", ""])
      expect(isCommentTargetType(type), type).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Schema enums vs web unions and constants
// ---------------------------------------------------------------------------

describe("schema.json enums = web unions and constants", () => {
  const CASES: Array<[string, readonly string[], string, string]> = [
    [
      "types.ts WikiSpace.visibility",
      unionValues<NonNullable<WikiSpace["visibility"]>>()(["public", "role", "department", "team"]),
      "api::wiki-space.wiki-space",
      "visibility",
    ],
    [
      "types.ts Acknowledgement.targetType",
      unionValues<Acknowledgement["targetType"]>()(["announcement", "document"]),
      "api::acknowledgement.acknowledgement",
      "targetType",
    ],
    [
      "types.ts Comment.targetType",
      unionValues<Comment["targetType"]>()(["announcement", "wiki-page"]),
      "api::comment.comment",
      "targetType",
    ],
    [
      "types.ts Reaction.targetType",
      unionValues<Reaction["targetType"]>()(["announcement", "wiki-page"]),
      "api::reaction.reaction",
      "targetType",
    ],
    [
      "types.ts EmojiType",
      unionValues<EmojiType>()(["thumbsup", "heart", "celebrate", "lightbulb", "laugh"]),
      "api::reaction.reaction",
      "emoji",
    ],
    [
      "types.ts RsvpStatus",
      unionValues<RsvpStatus>()(["yes", "no", "maybe"]),
      "api::event-rsvp.event-rsvp",
      "status",
    ],
    [
      "types.ts Notification.type",
      unionValues<Notification["type"]>()(["announcement", "comment", "event", "kudos"]),
      "api::notification.notification",
      "type",
    ],
    [
      "types.ts Poll.audience",
      unionValues<NonNullable<Poll["audience"]>>()(["all", "departments"]),
      "api::poll.poll",
      "audience",
    ],
    [
      "types.ts Document.category",
      unionValues<NonNullable<Document["category"]>>()([
        "policy",
        "form",
        "template",
        "guide",
        "other",
      ]),
      "api::document.document",
      "category",
    ],
    [
      "types.ts ClassifiedCategory",
      unionValues<ClassifiedCategory>()([
        "sale",
        "giveaway",
        "wanted",
        "service-offer",
        "service-wanted",
      ]),
      "api::classified.classified",
      "category",
    ],
    [
      "types.ts KudosValue",
      unionValues<KudosValue>()([
        "teamwork",
        "innovation",
        "leadership",
        "customer-focus",
        "excellence",
      ]),
      "api::kudos.kudos",
      "value",
    ],
    [
      "types.ts Course.completionMode",
      unionValues<NonNullable<Course["completionMode"]>>()(["confirm", "quizGate"]),
      "api::course.course",
      "completionMode",
    ],
    ["classified-shared AD_CATEGORIES", AD_CATEGORIES, "api::classified.classified", "category"],
    [
      "classified-shared AD_CATEGORY_KEYS",
      Object.keys(AD_CATEGORY_KEYS),
      "api::classified.classified",
      "category",
    ],
    ["reaction-summary ALL_EMOJIS", ALL_EMOJIS, "api::reaction.reaction", "emoji"],
    [
      "give-kudos.tsx VALUES",
      sourceStrings(
        "apps/web/src/components/kudos/give-kudos.tsx",
        /const VALUES:[\s\S]*?= \[([\s\S]*?)\];/,
        /value: "([^"]*)"/g,
      ),
      "api::kudos.kudos",
      "value",
    ],
    [
      "event-actions.ts STATUSES",
      sourceStrings(
        "apps/web/src/lib/event-actions.ts",
        /const STATUSES: RsvpStatus\[\] = \[([^\]]*)\]/,
      ),
      "api::event-rsvp.event-rsvp",
      "status",
    ],
    [
      "quick-links.tsx CATEGORY_ORDER",
      sourceStrings(
        "apps/web/src/components/dashboard/quick-links.tsx",
        /const CATEGORY_ORDER = \[([^\]]*)\]/,
      ),
      "api::quick-link.quick-link",
      "category",
    ],
    [
      "cms poll-audience.ts constants",
      [POLL_AUDIENCE_ALL, POLL_AUDIENCE_DEPARTMENTS],
      "api::poll.poll",
      "audience",
    ],
  ];

  it.each(CASES)("%s", (_label, web, uid, attribute) => {
    expect(sorted(web)).toEqual(sorted(enumOf(uid, attribute)));
    expect(new Set(web).size).toBe(web.length);
  });

  it("the poll audience default is the cms 'all'", () => {
    expect(SCHEMAS["api::poll.poll"].attributes.audience.default).toBe(POLL_AUDIENCE_ALL);
  });

  it("the live CHANNEL_RE accepts exactly the comment/reaction target types with a real documentId", () => {
    const [source] = sourceStrings(
      "apps/web/src/app/live/subscribe/route.ts",
      /const CHANNEL_RE = \/(.+)\/;/,
      /^(.*)$/g,
    );
    const channel = new RegExp(source);
    const documentId = "k3m9x0000000000000000000";
    for (const type of enumOf("api::comment.comment", "targetType")) {
      expect(channel.test(`${type}:${documentId}`), type).toBe(true);
    }
    // The alternation names the same types, nothing more.
    const alternation = /^\^\(([^)]*)\)/.exec(source)?.[1] ?? "";
    expect(sorted(alternation.split("|"))).toEqual(
      sorted(enumOf("api::reaction.reaction", "targetType")),
    );
    for (const bad of [
      `document:${documentId}`,
      `announcement:`,
      `announcement:${documentId}/x`,
      `wiki-page:${"a".repeat(65)}`,
    ]) {
      expect(channel.test(bad), bad).toBe(false);
    }
  });

  it("the guest flags: schema booleans defaulting to false = the web defaults and keys", () => {
    const poll = SCHEMAS["api::poll.poll"].attributes;
    const flags = ["guestsCanVote", "visibleToGuests"] as const;
    for (const flag of flags) {
      expect(poll[flag], flag).toMatchObject({ type: "boolean", default: false });
    }
    expect(sorted(Object.keys(NO_GUEST_ACCESS))).toEqual([...flags]);
    expect(NO_GUEST_ACCESS).toEqual({ visibleToGuests: false, guestsCanVote: false });
    // Both web shapes carry both flags (compile-time).
    const pollKeys: Array<keyof Poll> = [...flags];
    const resultKeys: Array<keyof PollResults["poll"]> = [...flags];
    expect(pollKeys).toEqual(resultKeys);
  });

  it("the guest flags: the web form normalisation matches the cms rules", () => {
    const values: unknown[] = [true, false, null, undefined, "true", 1, 0];
    for (const visibleToGuests of values) {
      for (const guestsCanVote of values) {
        const raw = { visibleToGuests, guestsCanVote } as GuestFlags;
        const web = normalizeGuestAccess(raw);
        const label = JSON.stringify(raw);
        expect(web.visibleToGuests, label).toBe(isPollVisibleToGuests(raw));
        expect(web.guestsCanVote, label).toBe(canGuestsVoteOnPoll(raw));
        // What the web sends is read back by the cms the same way.
        expect(canGuestsVoteOnPoll(web), label).toBe(canGuestsVoteOnPoll(raw));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Relation pairs
// ---------------------------------------------------------------------------

describe("relations: every mappedBy has its inversedBy and back", () => {
  /**
   * KNOWN: one phantom inverse side whose owning side names no inversedBy:
   * comment.replies -> comment.parent (writes to parent are blocked by FX04;
   * DA02 decides). Remove the entry when its pair is fixed. user.directReports
   * -> user.manager was the other one until FX23 paired it (2026-09-28f):
   * before that, populating directReports returned nothing.
   */
  const KNOWN_UNPAIRED = ["api::comment.comment.replies"];

  it("finds exactly the known unpaired sides", () => {
    const all = { ...pluginSchemas(), ...SCHEMAS };
    const problems: string[] = [];
    for (const [uid, schema] of Object.entries(all)) {
      for (const [name, attribute] of Object.entries(schema.attributes)) {
        if (attribute.type !== "relation" || !attribute.target) continue;
        const target = all[attribute.target];
        if (attribute.mappedBy) {
          const owner = target?.attributes[attribute.mappedBy];
          if (!owner || owner.target !== uid || owner.inversedBy !== name)
            problems.push(`${uid}.${name}`);
        }
        if (attribute.inversedBy) {
          const inverse = target?.attributes[attribute.inversedBy];
          if (!inverse || inverse.target !== uid || inverse.mappedBy !== name)
            problems.push(`${uid}.${name}`);
        }
      }
    }
    expect(sorted(problems)).toEqual(sorted(KNOWN_UNPAIRED));
  });
});

// ---------------------------------------------------------------------------
// 6. Web role sets vs the cms permission matrix
// ---------------------------------------------------------------------------

describe("web role sets = PERMISSION_MATRIX / CUSTOM_ACTION_GRANTS", () => {
  const MATRIX_ROLES = Object.keys(PERMISSION_MATRIX);

  const rolesWith = (uid: string, action: string) =>
    sorted(MATRIX_ROLES.filter((role) => PERMISSION_MATRIX[role]?.[uid]?.includes(action)));

  const grantedTo = (key: string) => {
    const grant = CUSTOM_ACTION_GRANTS[key];
    if (grant === undefined) throw new Error(`no custom grant ${key}`);
    return sorted(grant === "*" ? MATRIX_ROLES : grant);
  };

  const intersect = (a: readonly string[], b: readonly string[]) =>
    a.filter((role) => b.includes(role));

  /** The is-classified-author bypass per route (api/classified/routes/classified.ts). */
  const classifiedBypass = (action: "update" | "delete") =>
    sorted(
      sourceStrings(
        "apps/cms/src/api/classified/routes/classified.ts",
        new RegExp(`${action}: \\{[\\s\\S]*?bypassRoles: \\[([^\\]]*)\\]`),
      ),
    );

  it("ADMIN_ROLES: the admin-only analytics and role grants", () => {
    expect(sorted(webRoles.ADMIN_ROLES)).toEqual(grantedTo("api::search-log.search-log.summary"));
    expect(sorted(webRoles.ADMIN_ROLES)).toEqual(grantedTo("plugin::users-permissions.role.find"));
  });

  it("ADMIN_ROLES: editing any ad = the classified update bypass", () => {
    expect(sorted(webRoles.ADMIN_ROLES)).toEqual(classifiedBypass("update"));
  });

  it("POLL_CREATOR_ROLES: poll create", () => {
    expect(sorted(webRoles.POLL_CREATOR_ROLES)).toEqual(rolesWith("api::poll.poll", "create"));
  });

  it("RSVP_ROLES: event-rsvp create and update", () => {
    expect(sorted(webRoles.RSVP_ROLES)).toEqual(rolesWith("api::event-rsvp.event-rsvp", "create"));
    expect(sorted(webRoles.RSVP_ROLES)).toEqual(rolesWith("api::event-rsvp.event-rsvp", "update"));
  });

  it("AD_POSTER_ROLES: classified create AND the upload grant; the cleanup grant too", () => {
    const posters = intersect(
      rolesWith("api::classified.classified", "create"),
      grantedTo("plugin::upload.content-api.upload"),
    );
    expect(sorted(webRoles.AD_POSTER_ROLES)).toEqual(posters);
    expect(sorted(webRoles.AD_POSTER_ROLES)).toEqual(
      grantedTo("api::classified.classified.cleanupUploads"),
    );
  });

  it("search CONTACT_SEARCH_ROLES = the cms contact-field roles (FX22)", async () => {
    // Only these roles may filter users by e-mail: the cms guard
    // (middlewares/sensitive-query-guard.ts) refuses the clause for every
    // other role, so a drift makes the web search 400 or hide results.
    const { PRIVILEGED_ROLE_TYPES } = await cms<{ PRIVILEGED_ROLE_TYPES: ReadonlySet<string> }>(
      "utils/sanitize-user-contact.ts",
    );
    const web = sourceStrings(
      "apps/web/src/lib/search-action.ts",
      /CONTACT_SEARCH_ROLES: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/,
    );
    expect(sorted(web)).toEqual(sorted(PRIVILEGED_ROLE_TYPES));
    expect(web.every((role) => MATRIX_ROLES.includes(role))).toBe(true);
  });

  it("GUEST_ROLES: a real matrix role", () => {
    expect(sorted(webRoles.GUEST_ROLES)).toEqual(["guest"]);
    expect(MATRIX_ROLES).toContain("guest");
  });

  it("the report denominators: announcement.find and course.find", () => {
    const readers = sourceStrings(
      "apps/web/src/app/(app)/manage/acknowledgements/page.tsx",
      /const ANNOUNCEMENT_READER_ROLES = new Set\(\[([^\]]*)\]\)/,
    );
    expect(sorted(readers)).toEqual(rolesWith("api::announcement.announcement", "find"));
    const trainees = sourceStrings(
      "apps/web/src/app/(app)/manage/training/page.tsx",
      /const TRAINING_ROLES = new Set\(\[([^\]]*)\]\)/,
    );
    expect(sorted(trainees)).toEqual(rolesWith("api::course.course", "find"));
  });

  it("voting stays per poll: vote and results are granted to every role, the web has no role gate", () => {
    expect(CUSTOM_ACTION_GRANTS["api::poll-vote.poll-vote.vote"]).toBe("*");
    expect(CUSTOM_ACTION_GRANTS["api::poll-vote.poll-vote.results"]).toBe("*");
    expect(Object.keys(webRoles)).not.toContain("canVote");
  });

  /**
   * KNOWN until SH02, asserted as they are today:
   *   - ANNOUNCEMENT_READER_ROLES and TRAINING_ROLES are page-local copies,
   *     not roles.ts exports (their VALUES are pinned above);
   *   - no canComment / canReact: the web offers the comment form and the
   *     reaction bar to every role, while the matrix gives guest neither
   *     create;
   *   - no canDeleteAnyAd: the cms lets editor take any ad down (delete
   *     bypass), the web offers delete to the author and admins only.
   */
  it("KNOWN gaps (SH02) are exactly these", () => {
    const exported = Object.keys(webRoles);
    for (const missing of [
      "ANNOUNCEMENT_READER_ROLES",
      "TRAINING_ROLES",
      "canComment",
      "canReact",
      "canDeleteAnyAd",
      "canEditAnyAd",
      "canTrain",
    ]) {
      expect(exported, missing).not.toContain(missing);
    }
    const withoutCreate = (uid: string) =>
      MATRIX_ROLES.filter((role) => !rolesWith(uid, "create").includes(role));
    expect(withoutCreate("api::comment.comment")).toEqual(["guest"]);
    expect(withoutCreate("api::reaction.reaction")).toEqual(["guest"]);
    const deleteBypass = classifiedBypass("delete");
    expect(deleteBypass.filter((role) => !webRoles.ADMIN_ROLES.has(role))).toEqual(["editor"]);
  });
});
