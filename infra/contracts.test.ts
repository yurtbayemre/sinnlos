import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildAckReportRows,
  eligibleReportUsers,
  type ReportAnnouncement,
  type ReportUser,
} from "../apps/web/src/lib/ack-report";
import {
  isAnnouncementVisibleTo,
  teamIdsByUser,
  type AnnouncementAudience,
  type TeamMembership,
} from "../apps/web/src/lib/audience";
import { AD_CATEGORIES } from "../apps/web/src/lib/classified-shared";
import { AD_CATEGORY_LABELS } from "../apps/web/src/lib/classified-labels";
import {
  anchorOf,
  matchesTarget,
  targetFilterQuery,
  type CommentTargetType as WebCommentTargetType,
} from "../apps/web/src/lib/comment-target";
import { NO_GUEST_ACCESS, normalizeGuestAccess } from "../apps/web/src/lib/poll-guest-access";
import { CHANNEL_RE, LIVE_TARGET_TYPES } from "../apps/web/src/lib/live-contract";
import { ALL_EMOJIS } from "../apps/web/src/lib/reaction-summary";
import { ANNOUNCEMENT_READER_ROLES } from "../apps/web/src/lib/roles";
import {
  youtubeEmbedUrl,
  youtubeVideoId as webYoutubeVideoId,
} from "../apps/web/src/lib/training-shared";
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
 * build contexts, and the web's types and constants restate the cms schemas
 * by hand. The pure rules both apps apply live once, in @sinnlos/domain
 * (SH01; the package's own suites test them, and each app's
 * domain-reexports.test.ts pins that its old module paths hand out the
 * package's functions). This root suite pins what is still stated twice,
 * or where the two apps meet:
 *
 *   1. the announcement audience: the web acknowledgement report (lib/
 *      ack-report.ts, run as admin_role over the directory and the team
 *      roster) counts exactly the users the cms notifies and lets read
 *      (utils/visible-ids.ts announcementRecipients over loadAllUserScopes):
 *      the reader roles, blocked accounts and "member OR lead" of a team are
 *      built separately on each side; a seeded fuzz over whole orgs;
 *   2. lesson videos: the cms lesson validation (training-validation.ts,
 *      author feedback) saves exactly the URLs the web player (the
 *      AUTHORITATIVE render gate) embeds, and the embed stays on the
 *      no-cookie host; a corpus plus a seeded fuzz;
 *   3. comment/reaction targets: both apps and the schemas know the same
 *      target types, and a write the web sends is stored by the cms under
 *      the anchor the web's own section reads (filter and row re-check);
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
 *   6. the web search's contact-field roles against the cms's (FX22). The
 *      web role predicates and capabilities (lib/roles.ts, SH02) are pinned
 *      against PERMISSION_MATRIX / CUSTOM_ACTION_GRANTS by
 *      apps/web/src/lib/roles-matrix-parity.test.ts.
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

const { PERMISSION_MATRIX } = await cms<{ PERMISSION_MATRIX: RoleGrants }>(
  "bootstrap/permission-matrix.ts",
);

const { isAnnouncementVisible } = await cms<{
  isAnnouncementVisible(announcement: AnnouncementAudience, scope: unknown): boolean;
}>("utils/announcement-audience.ts");

/** The slice of Strapi's db.query the cms helpers below read (a fake here). */
interface FakeQueryStrapi {
  db: {
    query(uid: string): {
      findMany(params: Record<string, unknown>): Promise<unknown>;
      findOne(params: Record<string, unknown>): Promise<unknown>;
    };
  };
}

interface RecipientScope {
  userId: number;
}

const { NOT_BLOCKED, announcementRecipients, loadAllUserScopes } = await cms<{
  NOT_BLOCKED: unknown;
  loadAllUserScopes(strapi: FakeQueryStrapi): Promise<RecipientScope[]>;
  announcementRecipients(
    announcement: AnnouncementAudience,
    scopes: readonly RecipientScope[],
    readers: ReadonlySet<number>,
  ): RecipientScope[];
}>("utils/visible-ids.ts");

type WriteTargetResolution =
  | { status: "ok"; targetType: string; targetDocumentId: string }
  | { status: "rejected"; reason: string };

const { TARGET_UIDS, isCommentTargetType, resolveWriteTarget, targetMatchWhere } = await cms<{
  TARGET_UIDS: Record<string, string>;
  isCommentTargetType(value: unknown): boolean;
  targetMatchWhere(targetType: string, targetDocumentId: string): Record<string, unknown>;
  resolveWriteTarget(
    strapi: FakeQueryStrapi,
    input: { targetType?: string | null; targetDocumentId?: string | null },
  ): Promise<WriteTargetResolution>;
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

const { validateLessonData, youtubeVideoId: cmsYoutubeVideoId } = await cms<{
  validateLessonData(data: Record<string, unknown>): { normalized: unknown } | { error: string };
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
// 1. Announcement audience: the web ack report = the cms recipients
// ---------------------------------------------------------------------------

describe("announcement audience: the web ack report counts whom the cms notifies", () => {
  /** Role row ids of the fuzzed orgs: the cms decides by role id, the web report by type. */
  const ROLE_IDS = new Map(Object.keys(PERMISSION_MATRIX).map((type, index) => [type, index + 1]));
  const ROLE_TYPES = [...ROLE_IDS.keys()];
  /** What up_permissions holds: the role ids with announcement.find. */
  const READERS: ReadonlySet<number> = new Set(
    ROLE_TYPES.filter((type) =>
      PERMISSION_MATRIX[type]?.["api::announcement.announcement"]?.includes("find"),
    ).map((type) => ROLE_IDS.get(type)!),
  );

  const DEPARTMENTS = [10, 11, 12];
  const TEAMS = [30, 31, 32, 33];

  interface OrgUser {
    id: number;
    roleType: string | null;
    departmentId: number | null;
    /** A column value: users imported or seeded outside users-permissions can carry NULL. */
    blocked: boolean | null;
  }

  interface OrgTeam {
    id: number;
    leadId: number | null;
    memberIds: number[];
  }

  interface Org {
    users: OrgUser[];
    teams: OrgTeam[];
  }

  function randomOrg(random: () => number): Org {
    const users = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      roleType: random() < 0.1 ? null : pick(random, ROLE_TYPES),
      departmentId: random() < 0.2 ? null : pick(random, DEPARTMENTS),
      blocked: pick(random, [false, false, false, true, null]),
    }));
    const ids = users.map((user) => user.id);
    const teams = TEAMS.map((id) => ({
      id,
      // A lead is not automatically a member (team.lead has no inverse on the user).
      leadId: random() < 0.25 ? null : pick(random, ids),
      memberIds: subset(random, ids),
    }));
    return { users, teams };
  }

  function randomAnnouncement(random: () => number, id: number): ReportAnnouncement {
    return {
      id,
      documentId: `doc${id}`,
      requiresAck: true,
      audience: pick(random, ["all", "departments", null]),
      department: random() < 0.5 ? null : { id: pick(random, DEPARTMENTS) },
      team: random() < 0.5 ? null : { id: pick(random, TEAMS) },
      audienceRoles:
        random() < 0.5
          ? null
          : subset(random, ROLE_TYPES).map((type) => ({ id: ROLE_IDS.get(type)! })),
    };
  }

  /** The cms reads: loadAllUserScopes over a db.query fake that answers like the database. */
  function cmsStrapi(org: Org): FakeQueryStrapi {
    return {
      db: {
        query: (uid) => ({
          findOne: async () => {
            throw new Error("findOne is not expected here");
          },
          findMany: async (params) => {
            if (uid === "plugin::users-permissions.user") {
              expect(params.where).toEqual(NOT_BLOCKED);
              // NOT_BLOCKED in SQL: blocked is false or NULL.
              return org.users
                .filter((user) => user.blocked !== true)
                .map((user) => ({
                  id: user.id,
                  role:
                    user.roleType === null
                      ? null
                      : { id: ROLE_IDS.get(user.roleType), type: user.roleType },
                  department: user.departmentId === null ? null : { id: user.departmentId },
                  teams: org.teams
                    .filter((team) => team.memberIds.includes(user.id))
                    .map((team) => ({ id: team.id })),
                }));
            }
            if (uid === "api::team.team") {
              return org.teams.map((team) => ({
                id: team.id,
                lead: team.leadId === null ? null : { id: team.leadId },
              }));
            }
            throw new Error(`unexpected query ${uid}`);
          },
        }),
      },
    };
  }

  /** The web report over the directory and the roster as the page fetches them (JSON). */
  function webTargets(org: Org, announcement: ReportAnnouncement): number[] {
    const users = JSON.parse(
      JSON.stringify(
        org.users.map((user) => ({
          id: user.id,
          role:
            user.roleType === null
              ? null
              : { id: ROLE_IDS.get(user.roleType), type: user.roleType },
          department: user.departmentId === null ? null : { id: user.departmentId },
          blocked: user.blocked,
        })),
      ),
    ) as ReportUser[];
    const teams: TeamMembership[] = org.teams.map((team) => ({
      id: team.id,
      lead: team.leadId === null ? null : { id: team.leadId },
      members: team.memberIds.map((id) => ({ id })),
    }));
    const [row] = buildAckReportRows({
      announcements: [announcement],
      acks: new Map(),
      eligibleUsers: eligibleReportUsers(users, ANNOUNCEMENT_READER_ROLES),
      userTeamIds: teamIdsByUser(teams),
      usersUnknown: false,
      teamsUnknown: false,
    });
    return (row?.targetUsers ?? []).map((user) => user.id).sort((a, b) => a - b);
  }

  it("both apps decide with the one @sinnlos/domain predicate", () => {
    expect(isAnnouncementVisibleTo).toBe(isAnnouncementVisible);
  });

  it("agrees on 300 seeded orgs with 5 announcements each", async () => {
    const random = prng(0x5eed);
    const sizes = new Set<string>();
    for (let orgIndex = 0; orgIndex < 300; orgIndex += 1) {
      const org = randomOrg(random);
      const scopes = await loadAllUserScopes(cmsStrapi(org));
      for (let i = 0; i < 5; i += 1) {
        const announcement = randomAnnouncement(random, i + 1);
        const cms = announcementRecipients(announcement, scopes, READERS)
          .map((scope) => scope.userId)
          .sort((a, b) => a - b);
        expect(webTargets(org, announcement), JSON.stringify({ org, announcement })).toEqual(cms);
        sizes.add(cms.length === 0 ? "none" : cms.length === 12 ? "all" : "some");
      }
    }
    // The fuzz reaches empty and partial audiences (a full one is rare with blocked users).
    expect(sizes).toContain("none");
    expect(sizes).toContain("some");
  });

  it("counts a team's lead as targeted, like a member, on both sides", async () => {
    const org: Org = {
      users: [
        { id: 1, roleType: "member", departmentId: null, blocked: false },
        { id: 2, roleType: "team_lead", departmentId: null, blocked: null },
        { id: 3, roleType: "guest", departmentId: null, blocked: false },
      ],
      teams: [{ id: 30, leadId: 2, memberIds: [1, 3] }],
    };
    const announcement: ReportAnnouncement = { id: 1, documentId: "doc1", team: { id: 30 } };
    const scopes = await loadAllUserScopes(cmsStrapi(org));
    const cms = announcementRecipients(announcement, scopes, READERS).map((scope) => scope.userId);
    // The guest member is targeted but reads no announcements: neither side counts them.
    expect(cms.sort()).toEqual([1, 2]);
    expect(webTargets(org, announcement)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// 2. Lesson videos: what the cms saves = what the web embeds
// ---------------------------------------------------------------------------

describe("lesson videos: the cms saves exactly the URLs the web player embeds", () => {
  const ID = "dQw4w9WgXcQ";
  /** Accepted forms, refusals and edge cases of both apps' former suites. */
  const CORPUS: Array<[unknown, string | null]> = [
    [`https://www.youtube.com/watch?v=${ID}`, ID],
    [`https://youtu.be/${ID}`, ID],
    [`https://youtu.be/${ID}?t=42`, ID],
    [`https://www.youtube-nocookie.com/embed/${ID}`, ID],
    [`https://m.youtube.com/watch?v=${ID}`, ID],
    [`https://www.youtube.com/shorts/${ID}`, ID],
    [`  https://www.youtube.com/watch?v=${ID}  `, ID],
    [`https://www.youtube.com/live/${ID}`, ID],
    [`https://www.youtube.com/embed/${ID}?start=30`, ID],
    [`https://youtube.com/watch?v=${ID}&t=1s`, ID],
    [`https://WWW.YOUTUBE.COM/watch?v=${ID}`, ID],
    [`https://www.youtube.com:443/watch?v=${ID}`, ID],
    [`https://www.youtube-nocookie.com/watch?v=${ID}`, ID],
    [`https://youtu.be/${ID}/extra`, ID],
    [`http://www.youtube.com/watch?v=${ID}`, null],
    [`https://evil.example/watch?v=${ID}`, null],
    [`https://www.youtube.com.evil.example/watch?v=${ID}`, null],
    ["https://www.youtube.com/watch?v=<script>", null],
    ["https://www.youtube.com/watch?v=short", null],
    [`https://www.youtube.com/watch?v=${ID}x`, null],
    ["https://www.youtube.com/playlist?list=PL0123456789", null],
    ["https://youtu.be/", null],
    ["https://www.youtube.com/embed/", null],
    [`//www.youtube.com/watch?v=${ID}`, null],
    [`https://music.youtube.com/watch?v=${ID}`, null],
    ["javascript:alert(1)", null],
    [`javascript:alert(1)//https://www.youtube.com/watch?v=${ID}`, null],
    [`data:text/html,https://youtu.be/${ID}`, null],
    ["https://vimeo.com/12345678", null],
    ["   ", null],
    [42, null],
    [{}, null],
    [[`https://youtu.be/${ID}`], null],
  ];

  /** A value the cms lesson validation treats as "no video" (keys-present rule). */
  const cleared = (value: unknown) => value === null || value === undefined || value === "";

  /** Whether the cms accepts `videoUrl` on a lesson write. */
  const cmsSaves = (videoUrl: unknown) => !("error" in validateLessonData({ videoUrl }));

  it("both apps parse with the one @sinnlos/domain function", () => {
    expect(webYoutubeVideoId).toBe(cmsYoutubeVideoId);
  });

  it.each(CORPUS)("%s", (url, id) => {
    // The web player renders an embed exactly for a parsed id...
    expect(webYoutubeVideoId(url)).toBe(id);
    // ...and the cms saves the URL exactly then: no saved video stays blank.
    expect(cmsSaves(url)).toBe(id !== null);
    if (id !== null) {
      expect(youtubeEmbedUrl(id)).toBe(`https://www.youtube-nocookie.com/embed/${id}`);
    }
  });

  it("saves a cleared video (no URL), which the player renders as nothing", () => {
    for (const value of [null, undefined, ""]) {
      expect(cleared(value)).toBe(true);
      expect(cmsSaves(value), String(value)).toBe(true);
      expect(webYoutubeVideoId(value), String(value)).toBeNull();
    }
    expect(cmsSaves("   ")).toBe(false);
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
    const saved = new Set<boolean>();
    for (let i = 0; i < 3000; i += 1) {
      const url = `${pick(random, schemes)}${pick(random, hosts)}${pick(random, paths)()}`;
      const renders = webYoutubeVideoId(url) !== null;
      expect(cmsSaves(url), url).toBe(renders);
      saved.add(renders);
    }
    expect(saved).toEqual(new Set([true, false]));
  });
});

// ---------------------------------------------------------------------------
// 3. Comment / reaction targets
// ---------------------------------------------------------------------------

describe("comment/reaction targets: the web reads what the cms stores for its writes", () => {
  /** documentId values as a section's target may carry them. */
  const VALUES: unknown[] = [
    "k3m9x0000000000000000000",
    " k3m9x0000000000000000000 ",
    "\tabc\n",
    " abc ",
    "",
    "   ",
    " ",
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

  /** Every target that exists: the anchors of the string values. */
  const EXISTING = new Set(
    VALUES.filter((value): value is string => typeof value === "string" && value.trim() !== "").map(
      (value) => value.trim(),
    ),
  );

  /** The cms lookups of resolveWriteTarget: a target row exists for EXISTING anchors. */
  const strapi: FakeQueryStrapi = {
    db: {
      query: () => ({
        findMany: async () => {
          throw new Error("findMany is not expected here");
        },
        findOne: async (params) => {
          const where = params.where as { documentId?: unknown };
          return typeof where.documentId === "string" && EXISTING.has(where.documentId)
            ? { id: 1, documentId: where.documentId }
            : null;
        },
      }),
    },
  };

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

  it.each(VALUES)("%j", async (value) => {
    for (const type of Object.keys(TARGET_UIDS) as WebCommentTargetType[]) {
      const target = { type, documentId: value as string | null | undefined };
      // The web writes the anchor only (comment-actions.ts writeAnchor).
      const sent = anchorOf(value);
      if (sent === null) {
        // No anchor: the web neither writes nor reads, and the cms would
        // refuse the raw value too.
        expect(targetFilterQuery(target), type).toBeNull();
        const refused = await resolveWriteTarget(strapi, {
          targetType: type,
          targetDocumentId: value as string | null | undefined,
        });
        expect(refused, type).toEqual({ status: "rejected", reason: "missing-target" });
        continue;
      }
      const stored = await resolveWriteTarget(strapi, { targetType: type, targetDocumentId: sent });
      expect(stored.status, type).toBe("ok");
      if (stored.status !== "ok") continue;
      const row = { targetType: stored.targetType, targetDocumentId: stored.targetDocumentId };
      // The section's query filters on the stored anchor, and its per-row
      // re-check keeps the row; the other target type never does.
      expect(targetFilterQuery(target), type).toBe(
        `filters[targetType][$eq]=${encodeURIComponent(type)}` +
          `&filters[targetDocumentId][$eq]=${encodeURIComponent(stored.targetDocumentId)}`,
      );
      expect(matchesTarget(row, target), type).toBe(true);
      const other = type === "announcement" ? "wiki-page" : "announcement";
      expect(matchesTarget(row, { type: other, documentId: value as string }), type).toBe(false);
      // The cms's own lookups of the thread use the same pair.
      expect(targetMatchWhere(type, stored.targetDocumentId)).toEqual(row);
    }
  });

  it("refuses a write to a target that does not exist", async () => {
    await expect(
      resolveWriteTarget(strapi, { targetType: "announcement", targetDocumentId: "missing" }),
    ).resolves.toEqual({ status: "rejected", reason: "unresolved-target" });
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
      "classified-labels AD_CATEGORY_LABELS",
      Object.keys(AD_CATEGORY_LABELS),
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
    // The live contract (LF04, apps/web/src/lib/live-contract.ts, byte-
    // identical in the cms) builds CHANNEL_RE from LIVE_TARGET_TYPES.
    const channel = CHANNEL_RE;
    const documentId = "k3m9x0000000000000000000";
    for (const type of enumOf("api::comment.comment", "targetType")) {
      expect(channel.test(`${type}:${documentId}`), type).toBe(true);
    }
    // The alternation names the same types, nothing more.
    expect(sorted([...LIVE_TARGET_TYPES])).toEqual(
      sorted(enumOf("api::reaction.reaction", "targetType")),
    );
    const alternation = /^\^\(\?:([^)]*)\)/.exec(channel.source)?.[1] ?? "";
    expect(sorted(alternation.split("|"))).toEqual(sorted([...LIVE_TARGET_TYPES]));
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
// 6. Contact-search roles (the web role predicates: roles-matrix-parity.test.ts)
// ---------------------------------------------------------------------------

describe("web search CONTACT_SEARCH_ROLES = the cms contact-field roles (FX22)", () => {
  const MATRIX_ROLES = Object.keys(PERMISSION_MATRIX);

  it("names exactly the roles the cms lets filter by e-mail", async () => {
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
});
