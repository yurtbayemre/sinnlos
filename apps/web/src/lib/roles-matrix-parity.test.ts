import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as roles from "./roles";
import {
  AUTHORING_AREAS,
  capabilitiesFor,
  type AuthoringArea,
  type AuthoringVerb,
  type ReadSection,
} from "./roles";

/**
 * SH02 parity: every web role predicate, role set and capability of
 * lib/roles.ts against the grants the cms bootstrap converges to
 * (apps/cms/src/bootstrap/permission-matrix.ts PERMISSION_MATRIX and
 * CUSTOM_ACTION_GRANTS) and the route-policy bypass lists that sit on top
 * of them. A grant change in the cms that the web does not mirror fails
 * here, in both directions: a role that gains a grant must gain the web
 * control, one that loses it must lose the control.
 *
 * The cms module is loaded at run time through a typed facade, like
 * infra/contracts.test.ts: this file is type-checked by the STRICT
 * web/infra program (tsconfig.test.json), which must not pull cms code in
 * (S07).
 *
 * The Capabilities values follow decision 06 §L2 (batch 13): AUTHORING_GRANTS
 * maps every (area, verb) to the cms action that decides it, and
 * `authorScope` is null exactly where `author` is empty and "any" otherwise,
 * for the moderators only. A non-moderator with a non-empty area fails until
 * batch 15 adds the department-author branch ("ownDepartment").
 */

const ROOT = join(__dirname, "..", "..", "..", "..");
const CMS_SRC = join(ROOT, "apps", "cms", "src");

type RoleGrants = Record<string, Record<string, readonly string[] | undefined>>;

const { PERMISSION_MATRIX, CUSTOM_ACTION_GRANTS } = (await import(
  join(CMS_SRC, "bootstrap", "permission-matrix.ts")
)) as {
  PERMISSION_MATRIX: RoleGrants;
  CUSTOM_ACTION_GRANTS: Record<string, readonly string[] | "*" | undefined>;
};

const { MODERATORS } = (await import(join(CMS_SRC, "bootstrap", "roles.ts"))) as {
  MODERATORS: readonly string[];
};

const { DIGEST_EXCLUDED_ROLE_TYPES } = (await import(
  join(CMS_SRC, "digest", "send-digests.ts")
)) as { DIGEST_EXCLUDED_ROLE_TYPES: readonly string[] };

const MATRIX_ROLES = Object.keys(PERMISSION_MATRIX);

/** Every action a role holds: its matrix grants plus the custom actions ('*' = every matrix role). */
function grantsOf(role: string): ReadonlySet<string> {
  const actions = new Set<string>();
  for (const [uid, list] of Object.entries(PERMISSION_MATRIX[role] ?? {})) {
    for (const action of list ?? []) actions.add(`${uid}.${action}`);
  }
  for (const [action, grant] of Object.entries(CUSTOM_ACTION_GRANTS)) {
    if (grant === "*" || grant?.includes(role)) actions.add(action);
  }
  return actions;
}

const GRANTS = new Map(MATRIX_ROLES.map((role) => [role, grantsOf(role)]));
const holds = (role: string, ...actions: string[]) =>
  actions.every((action) => GRANTS.get(role)?.has(action) === true);

const sorted = (values: Iterable<string>) => [...values].sort();
const holders = (...actions: string[]) =>
  sorted(MATRIX_ROLES.filter((role) => holds(role, ...actions)));

/** The is-classified-author bypass per route (apps/cms/src/api/classified/routes/classified.ts). */
function classifiedBypass(action: "update" | "delete"): string[] {
  const source = readFileSync(
    join(CMS_SRC, "api", "classified", "routes", "classified.ts"),
    "utf8",
  );
  const match = new RegExp(`${action}: \\{[\\s\\S]*?bypassRoles: \\[([^\\]]*)\\]`).exec(source);
  if (!match) throw new Error(`classified ${action} bypassRoles not found; update this test`);
  return [...match[1]!.matchAll(/"([^"]*)"/g)].map((found) => found[1]!);
}

const UPDATE_BYPASS = classifiedBypass("update");
const DELETE_BYPASS = classifiedBypass("delete");

/** Values that are no role: every predicate denies them, every capability is empty. */
const NOT_A_ROLE: (string | null | undefined)[] = [
  undefined,
  null,
  "",
  "public",
  "Admin_role",
  "EDITOR",
  "member ",
  "admin",
];

const A = {
  announcement: "api::announcement.announcement",
  acknowledgement: "api::acknowledgement.acknowledgement",
  classified: "api::classified.classified",
  comment: "api::comment.comment",
  course: "api::course.course",
  department: "api::department.department",
  eventRsvp: "api::event-rsvp.event-rsvp",
  kudos: "api::kudos.kudos",
  lesson: "api::lesson.lesson",
  lessonProgress: "api::lesson-progress.lesson-progress",
  poll: "api::poll.poll",
  reaction: "api::reaction.reaction",
  team: "api::team.team",
  wikiPage: "api::wiki-page.wiki-page",
} as const;

/** What each web predicate means in cms terms; the role holds all of it. */
const PREDICATES: Array<{
  name: string;
  predicate: (role: string | null | undefined) => boolean;
  set: ReadonlySet<string>;
  expected: (role: string) => boolean;
}> = [
  {
    // The admin-only analytics summary and the role.find the ack report needs.
    name: "isAdmin",
    predicate: roles.isAdmin,
    set: roles.ADMIN_ROLES,
    expected: (role) =>
      holds(role, "api::search-log.search-log.summary", "plugin::users-permissions.role.find"),
  },
  {
    name: "canCreatePolls",
    predicate: roles.canCreatePolls,
    set: roles.POLL_CREATOR_ROLES,
    expected: (role) => holds(role, `${A.poll}.create`),
  },
  {
    name: "canRsvp",
    predicate: roles.canRsvp,
    set: roles.RSVP_ROLES,
    expected: (role) => holds(role, `${A.eventRsvp}.create`, `${A.eventRsvp}.update`),
  },
  {
    // Classified create AND the upload grant AND the orphan cleanup of the two-step flow.
    name: "canPostAds",
    predicate: roles.canPostAds,
    set: roles.AD_POSTER_ROLES,
    expected: (role) =>
      holds(
        role,
        `${A.classified}.create`,
        "plugin::upload.content-api.upload",
        `${A.classified}.cleanupUploads`,
      ),
  },
  {
    name: "canDeleteAnyAd",
    predicate: roles.canDeleteAnyAd,
    set: roles.AD_MODERATOR_ROLES,
    expected: (role) => holds(role, `${A.classified}.delete`) && DELETE_BYPASS.includes(role),
  },
  {
    name: "canEditAnyAd",
    predicate: roles.canEditAnyAd,
    set: roles.AD_EDITOR_ROLES,
    expected: (role) => holds(role, `${A.classified}.update`) && UPDATE_BYPASS.includes(role),
  },
  {
    name: "canComment",
    predicate: roles.canComment,
    set: roles.COMMENTER_ROLES,
    expected: (role) => holds(role, `${A.comment}.create`),
  },
  {
    name: "canDeleteOwnComments",
    predicate: roles.canDeleteOwnComments,
    set: roles.COMMENT_DELETER_ROLES,
    expected: (role) => holds(role, `${A.comment}.delete`),
  },
  {
    // The toggle is a create with the desired end state (FX28), for both directions.
    name: "canReact",
    predicate: roles.canReact,
    set: roles.REACTOR_ROLES,
    expected: (role) => holds(role, `${A.reaction}.create`),
  },
  {
    name: "canTrain",
    predicate: roles.canTrain,
    set: roles.TRAINING_ROLES,
    expected: (role) =>
      holds(
        role,
        `${A.course}.find`,
        `${A.lesson}.find`,
        `${A.lessonProgress}.find`,
        `${A.lessonProgress}.create`,
      ),
  },
  {
    // The digest run sends to the announcement.find holders outside
    // DIGEST_EXCLUDED_ROLE_TYPES (FX19).
    name: "canReceiveDigests",
    predicate: roles.canReceiveDigests,
    set: roles.DIGEST_ROLES,
    expected: (role) =>
      holds(role, `${A.announcement}.find`) && !DIGEST_EXCLUDED_ROLE_TYPES.includes(role),
  },
];

describe("web predicates = the cms grants", () => {
  it.each(PREDICATES)("$name", ({ predicate, set, expected }) => {
    for (const role of MATRIX_ROLES) {
      expect(predicate(role), role).toBe(expected(role));
    }
    expect(sorted(set)).toEqual(sorted(MATRIX_ROLES.filter(expected)));
    for (const role of NOT_A_ROLE) {
      expect(predicate(role), String(role)).toBe(false);
    }
  });

  it("the report denominators: announcement.find and the training reads", () => {
    expect(sorted(roles.ANNOUNCEMENT_READER_ROLES)).toEqual(holders(`${A.announcement}.find`));
    expect(sorted(roles.TRAINING_ROLES)).toEqual(holders(`${A.course}.find`));
  });

  it("KNOWN_ROLES are the matrix roles, and guest is one of them", () => {
    expect(sorted(roles.KNOWN_ROLES)).toEqual(sorted(MATRIX_ROLES));
    expect(sorted(roles.GUEST_ROLES)).toEqual(["guest"]);
  });
});

/** The cms reads each page section needs; the role holds all of them. */
const SECTION_READS: Record<ReadSection, string[]> = {
  announcements: [`${A.announcement}.find`],
  acknowledgements: [`${A.acknowledgement}.find`, `${A.acknowledgement}.create`],
  departments: [`${A.department}.find`, `${A.department}.findOne`],
  teams: [`${A.team}.find`, `${A.team}.findOne`],
  kudos: [`${A.kudos}.find`],
  celebrations: ["api::kudos.kudos.celebrations"],
  marketplace: [`${A.classified}.find`, `${A.classified}.findOne`],
  training: [
    `${A.course}.find`,
    `${A.lesson}.find`,
    `${A.lesson}.findOne`,
    `${A.lessonProgress}.find`,
  ],
};

describe("read sections = the cms read grants", () => {
  it("covers exactly the sections of READ_SECTIONS", () => {
    expect(sorted(Object.keys(roles.READ_SECTIONS))).toEqual(sorted(Object.keys(SECTION_READS)));
  });

  it.each(Object.entries(SECTION_READS) as Array<[ReadSection, string[]]>)(
    "%s",
    (section, actions) => {
      for (const role of MATRIX_ROLES) {
        const reads = holds(role, ...actions);
        expect(roles.canRead(role, section), role).toBe(reads);
        expect(roles.isReadDenied(role, section), role).toBe(!reads);
      }
      for (const role of NOT_A_ROLE) {
        expect(roles.canRead(role, section), String(role)).toBe(false);
        expect(roles.isReadDenied(role, section), String(role)).toBe(false);
      }
    },
  );
});

/**
 * Decision 06 §L2: area → verb → the cms action that decides it. `edit` and
 * `schedule` are `update`, `discard` is `discardDraft`; publish, unpublish
 * and discardDraft do not exist before batch 15, so no role holds them yet.
 * A verb an area does not offer (§A: a poll is published at create and
 * closed by closesAt; a wiki space at save) has no entry.
 */
const AUTHORING_GRANTS: Record<AuthoringArea, Partial<Record<AuthoringVerb, string>>> = (() => {
  const draftAndPublish = (uid: string, withDelete: boolean) => ({
    create: `${uid}.create`,
    edit: `${uid}.update`,
    publish: `${uid}.publish`,
    unpublish: `${uid}.unpublish`,
    schedule: `${uid}.update`,
    discard: `${uid}.discardDraft`,
    ...(withDelete ? { delete: `${uid}.delete` } : {}),
  });
  const plain = (uid: string) => ({
    create: `${uid}.create`,
    edit: `${uid}.update`,
    delete: `${uid}.delete`,
  });
  return {
    announcements: draftAndPublish(A.announcement, true),
    events: draftAndPublish("api::event.event", true),
    polls: plain(A.poll),
    quickLinks: draftAndPublish("api::quick-link.quick-link", true),
    documents: draftAndPublish("api::document.document", true),
    wikiSpaces: plain("api::wiki-space.wiki-space"),
    // Training deletes stay in the admin panel (§I).
    courses: draftAndPublish(A.course, false),
    lessons: draftAndPublish(A.lesson, false),
  };
})();

const VERBS: AuthoringVerb[] = [
  "create",
  "edit",
  "publish",
  "unpublish",
  "schedule",
  "discard",
  "delete",
];

describe("capabilitiesFor = the cms grants (decision 06 §L2)", () => {
  it("covers every authoring area", () => {
    expect(sorted(AUTHORING_AREAS)).toEqual(sorted(Object.keys(AUTHORING_GRANTS)));
  });

  it.each(MATRIX_ROLES)(
    "%s: author[area] has a verb exactly when the role holds its action",
    (role) => {
      const caps = capabilitiesFor(role);
      for (const area of AUTHORING_AREAS) {
        for (const verb of VERBS) {
          const action = AUTHORING_GRANTS[area][verb];
          expect(caps.author[area].has(verb), `${area}.${verb}`).toBe(
            action !== undefined && holds(role, action),
          );
        }
      }
    },
  );

  it.each(MATRIX_ROLES)("%s: authorScope is null exactly where author is empty", (role) => {
    const caps = capabilitiesFor(role);
    for (const area of AUTHORING_AREAS) {
      if (caps.author[area].size === 0) {
        expect(caps.authorScope[area], area).toBeNull();
      } else {
        // Batch 13: only moderators author; batch 15 adds "ownDepartment"
        // for the department authors together with their grants.
        expect(MODERATORS, `${role} authors ${area}`).toContain(role);
        expect(caps.authorScope[area], area).toBe("any");
      }
    }
  });

  it.each(MATRIX_ROLES)("%s: wikiPages mirror the wiki-page grants and can-edit-wiki", (role) => {
    const { wikiPages } = capabilitiesFor(role);
    const moderator = MODERATORS.includes(role);
    expect(wikiPages.create).toBe(holds(role, `${A.wikiPage}.create`));
    // can-edit-wiki: moderators bypass, every other holder of update is
    // limited to its row classes (own page, head, lead).
    expect(wikiPages.edit).toBe(
      !holds(role, `${A.wikiPage}.update`) ? "none" : moderator ? "any" : "row",
    );
    expect(wikiPages.unpublish).toBe(holds(role, `${A.wikiPage}.unpublish`));
    expect(wikiPages.schedule).toBe(holds(role, `${A.wikiPage}.update`) && moderator);
    expect(wikiPages.delete).toBe(holds(role, `${A.wikiPage}.delete`));
  });

  it.each(MATRIX_ROLES)("%s: org edits mirror the update grants and their policies", (role) => {
    const { org } = capabilitiesFor(role);
    // can-edit-department / can-edit-team: moderators bypass (only
    // admin_role holds the update), heads and leads edit their own.
    const scope = (uid: string) =>
      !holds(role, `${uid}.update`) ? "none" : MODERATORS.includes(role) ? "any" : "own";
    expect(org.editDepartment).toBe(scope(A.department));
    expect(org.editTeam).toBe(scope(A.team));
  });

  it.each(MATRIX_ROLES)("%s: manage and the reports follow the admin page gates (§L1)", (role) => {
    const caps = capabilitiesFor(role);
    const admin = roles.isAdmin(role);
    expect(caps.manage).toBe(admin);
    expect(caps.reports.analytics).toBe(holds(role, "api::search-log.search-log.summary"));
    expect(caps.reports.acknowledgements).toBe(holds(role, "plugin::users-permissions.role.find"));
    expect(caps.reports.training).toBe(admin);
    expect(caps.reports.activity).toBe(false);
  });

  it("gives a value that is no role nothing", () => {
    for (const role of NOT_A_ROLE) {
      const caps = capabilitiesFor(role);
      expect(caps.manage, String(role)).toBe(false);
      for (const area of AUTHORING_AREAS) {
        expect(caps.author[area].size, `${role} ${area}`).toBe(0);
        expect(caps.authorScope[area], `${role} ${area}`).toBeNull();
      }
    }
  });
});

describe("voting stays per poll", () => {
  it("grants vote and results to every role ('*'); the web has no role gate for them", () => {
    expect(CUSTOM_ACTION_GRANTS["api::poll-vote.poll-vote.vote"]).toBe("*");
    expect(CUSTOM_ACTION_GRANTS["api::poll-vote.poll-vote.results"]).toBe("*");
    expect(Object.keys(roles)).not.toContain("canVote");
  });
});
