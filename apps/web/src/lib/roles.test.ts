import { describe, expect, it } from "vitest";
import {
  ACKNOWLEDGER_ROLES,
  AD_EDITOR_ROLES,
  AD_MODERATOR_ROLES,
  AD_POSTER_ROLES,
  AD_READER_ROLES,
  ADMIN_ROLES,
  ANNOUNCEMENT_READER_ROLES,
  AUTHORING_AREAS,
  canComment,
  canCreatePolls,
  canDeleteAnyAd,
  canDeleteOwnComments,
  canEditAnyAd,
  canPostAds,
  canReact,
  canRead,
  canReceiveDigests,
  canRsvp,
  canTrain,
  capabilitiesFor,
  CELEBRATION_ROLES,
  COMMENT_DELETER_ROLES,
  COMMENTER_ROLES,
  DIGEST_ROLES,
  GUEST_ROLES,
  isAdmin,
  isGuest,
  isReadDenied,
  KNOWN_ROLES,
  KUDOS_READER_ROLES,
  ORG_READER_ROLES,
  POLL_CREATOR_ROLES,
  READ_SECTIONS,
  REACTOR_ROLES,
  RSVP_ROLES,
  TRAINING_ROLES,
  type ReadSection,
} from "./roles";

/**
 * `isAdmin` gates admin-only UI/actions on the web side. Its contract is
 * narrow but security-relevant: ONLY the exact `admin_role` type is admin,
 * and any nullish/unknown role is non-admin (fail-closed).
 */
describe("isAdmin", () => {
  it("returns true only for the exact admin_role type", () => {
    expect(isAdmin("admin_role")).toBe(true);
  });

  it("returns false for non-admin role types", () => {
    for (const role of ["editor", "department_head", "team_lead", "member", "guest"]) {
      expect(isAdmin(role)).toBe(false);
    }
  });

  it("fails closed for nullish input", () => {
    expect(isAdmin(undefined)).toBe(false);
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin("")).toBe(false);
  });

  it("does not treat lookalike / differently-cased values as admin", () => {
    // Guards against case-folding or substring regressions.
    expect(isAdmin("Admin_Role")).toBe(false);
    expect(isAdmin("ADMIN_ROLE")).toBe(false);
    expect(isAdmin("admin")).toBe(false);
    expect(isAdmin("admin_role ")).toBe(false);
    expect(isAdmin(" admin_role")).toBe(false);
    expect(isAdmin("superadmin_role")).toBe(false);
  });

  it("ADMIN_ROLES contains only admin_role", () => {
    expect([...ADMIN_ROLES]).toEqual(["admin_role"]);
  });
});

/**
 * The capability predicates behind the poll, RSVP and marketplace gates
 * (D-SESSION-01). The role comes from getViewer() and is null whenever it
 * could not be read — every predicate must then deny. Guest is excluded by
 * an allowlist, never by a `role !== "guest"` check, which let role-less
 * (Microsoft) sessions through (investigations.md #1).
 */
const ALL_ROLES = [
  "admin_role",
  "editor",
  "department_head",
  "team_lead",
  "member",
  "guest",
  "authenticated",
  "public",
];
const STAFF = ["admin_role", "editor", "department_head", "team_lead", "member"];
const STAFF_AND_FALLBACK = [...STAFF, "authenticated"];
const NOT_A_ROLE: (string | null | undefined)[] = [
  undefined,
  null,
  "",
  "Editor",
  "MEMBER",
  "member ",
  "admin",
  "unknown_role",
];

describe.each([
  {
    name: "canCreatePolls",
    predicate: canCreatePolls,
    set: POLL_CREATOR_ROLES,
    allowed: ["admin_role", "editor"],
  },
  {
    name: "canRsvp",
    predicate: canRsvp,
    set: RSVP_ROLES,
    allowed: STAFF_AND_FALLBACK,
  },
  {
    name: "canPostAds",
    predicate: canPostAds,
    set: AD_POSTER_ROLES,
    allowed: STAFF,
  },
  {
    name: "canDeleteAnyAd",
    predicate: canDeleteAnyAd,
    set: AD_MODERATOR_ROLES,
    allowed: ["admin_role", "editor"],
  },
  { name: "canEditAnyAd", predicate: canEditAnyAd, set: AD_EDITOR_ROLES, allowed: ["admin_role"] },
  { name: "canComment", predicate: canComment, set: COMMENTER_ROLES, allowed: STAFF_AND_FALLBACK },
  {
    name: "canDeleteOwnComments",
    predicate: canDeleteOwnComments,
    set: COMMENT_DELETER_ROLES,
    allowed: STAFF,
  },
  { name: "canReact", predicate: canReact, set: REACTOR_ROLES, allowed: STAFF_AND_FALLBACK },
  { name: "canTrain", predicate: canTrain, set: TRAINING_ROLES, allowed: STAFF_AND_FALLBACK },
  {
    name: "canReceiveDigests",
    predicate: canReceiveDigests,
    set: DIGEST_ROLES,
    allowed: STAFF_AND_FALLBACK,
  },
])("$name", ({ predicate, set, allowed }) => {
  it("allows exactly the listed role types", () => {
    for (const role of ALL_ROLES) {
      expect(predicate(role), role).toBe(allowed.includes(role));
    }
    expect([...set].sort()).toEqual([...allowed].sort());
  });

  it("never allows guest", () => {
    expect(predicate("guest")).toBe(false);
  });

  it("fails closed for a missing, unknown or differently-cased role", () => {
    for (const role of NOT_A_ROLE) {
      expect(predicate(role), String(role)).toBe(false);
    }
  });
});

/**
 * `isGuest` only picks the poll card's wording for a guest (owner decision
 * 2026-09-27); it gates nothing. Exact match like every helper here.
 */
describe("isGuest", () => {
  it("is true for the exact guest role type only", () => {
    for (const role of ALL_ROLES) {
      expect(isGuest(role), role).toBe(role === "guest");
    }
    expect([...GUEST_ROLES]).toEqual(["guest"]);
  });

  it("is false for a missing, unknown or differently-cased role", () => {
    for (const role of [...NOT_A_ROLE, "Guest", "GUEST", " guest", "guests"]) {
      expect(isGuest(role), String(role)).toBe(false);
    }
  });
});

/**
 * The read sections (the guest-403 fix): canRead is fail-closed like every
 * gate; isReadDenied is true only for a KNOWN role without the read, so a
 * missing or unknown role still reads and the CMS decides (an outage then
 * shows the error banner, not "not available for your role").
 */
describe("read sections", () => {
  const SECTIONS = Object.keys(READ_SECTIONS) as ReadSection[];
  const EXPECTED: Record<ReadSection, [ReadonlySet<string>, string[]]> = {
    announcements: [ANNOUNCEMENT_READER_ROLES, STAFF_AND_FALLBACK],
    acknowledgements: [ACKNOWLEDGER_ROLES, STAFF_AND_FALLBACK],
    departments: [ORG_READER_ROLES, STAFF_AND_FALLBACK],
    teams: [ORG_READER_ROLES, STAFF_AND_FALLBACK],
    kudos: [KUDOS_READER_ROLES, STAFF_AND_FALLBACK],
    celebrations: [CELEBRATION_ROLES, STAFF],
    marketplace: [AD_READER_ROLES, STAFF_AND_FALLBACK],
    training: [TRAINING_ROLES, STAFF_AND_FALLBACK],
  };

  it("lists exactly these sections, each with its role set", () => {
    expect([...SECTIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const section of SECTIONS) {
      const [set, allowed] = EXPECTED[section];
      expect(READ_SECTIONS[section], section).toBe(set);
      expect([...set].sort(), section).toEqual([...allowed].sort());
    }
  });

  it.each(SECTIONS)("%s: canRead allows exactly the set, fail-closed", (section) => {
    const [, allowed] = EXPECTED[section];
    for (const role of ALL_ROLES) {
      expect(canRead(role, section), role).toBe(allowed.includes(role));
    }
    for (const role of NOT_A_ROLE) {
      expect(canRead(role, section), String(role)).toBe(false);
    }
  });

  it.each(SECTIONS)("%s: isReadDenied only for a known role without the read", (section) => {
    const [, allowed] = EXPECTED[section];
    for (const role of ALL_ROLES) {
      const known = role !== "public";
      expect(isReadDenied(role, section), role).toBe(known && !allowed.includes(role));
    }
    for (const role of NOT_A_ROLE) {
      expect(isReadDenied(role, section), String(role)).toBe(false);
    }
  });

  it("denies guest every section and the `authenticated` fallback only the celebrations", () => {
    expect(SECTIONS.filter((section) => isReadDenied("guest", section)).sort()).toEqual(
      [...SECTIONS].sort(),
    );
    expect(SECTIONS.filter((section) => isReadDenied("authenticated", section))).toEqual([
      "celebrations",
    ]);
  });

  it("knows the six seeded roles and the fallback", () => {
    expect([...KNOWN_ROLES].sort()).toEqual([...STAFF_AND_FALLBACK, "guest"].sort());
  });

  it("sends digests to the announcement readers", () => {
    expect(DIGEST_ROLES).toBe(ANNOUNCEMENT_READER_ROLES);
  });
});

/**
 * capabilitiesFor (decision 06 §L2, batch 13 values): role-only and
 * fail-closed. The values are pinned to the CMS grants in
 * roles-matrix-parity.test.ts; here the shape and the fail-closed rule.
 */
describe("capabilitiesFor", () => {
  it("gives a missing, unknown or differently-cased role nothing", () => {
    for (const role of [...NOT_A_ROLE, "public"]) {
      const caps = capabilitiesFor(role);
      expect(caps.manage, String(role)).toBe(false);
      for (const area of AUTHORING_AREAS) {
        expect(caps.author[area].size, `${role} ${area}`).toBe(0);
        expect(caps.authorScope[area], `${role} ${area}`).toBeNull();
      }
      expect(caps.wikiPages).toEqual({
        create: false,
        edit: "none",
        unpublish: false,
        schedule: false,
        delete: false,
      });
      expect(caps.org).toEqual({ editDepartment: "none", editTeam: "none" });
      expect(caps.reports).toEqual({
        analytics: false,
        acknowledgements: false,
        training: false,
        activity: false,
      });
    }
  });

  it("opens /manage and the reports to admin_role only (§L1: until batch 15)", () => {
    for (const role of ALL_ROLES) {
      const caps = capabilitiesFor(role);
      const admin = role === "admin_role";
      expect(caps.manage, role).toBe(admin);
      expect(caps.reports, role).toEqual({
        analytics: admin,
        acknowledgements: admin,
        training: admin,
        activity: false,
      });
    }
  });

  it("scopes every non-empty authoring area to 'any', and only the moderators author", () => {
    for (const role of ALL_ROLES) {
      const caps = capabilitiesFor(role);
      for (const area of AUTHORING_AREAS) {
        const verbs = caps.author[area];
        expect(caps.authorScope[area], `${role} ${area}`).toBe(verbs.size > 0 ? "any" : null);
        if (!["admin_role", "editor"].includes(role)) {
          expect(verbs.size, `${role} ${area}`).toBe(0);
        }
      }
    }
    expect([...capabilitiesFor("editor").author.polls].sort()).toEqual([
      "create",
      "delete",
      "edit",
    ]);
    expect(capabilitiesFor("admin_role").author.courses.size).toBe(0);
  });

  it("hands out a fresh, frozen object per call", () => {
    const first = capabilitiesFor("editor");
    const second = capabilitiesFor("editor");
    expect(first).not.toBe(second);
    expect(first.author.announcements).not.toBe(second.author.announcements);
    expect(Object.isFrozen(first.author)).toBe(true);
    expect(Object.isFrozen(first.authorScope)).toBe(true);
  });
});
