import { describe, expect, it } from "vitest";
import {
  isAnnouncementVisibleTo,
  teamIdsByUser,
  type AnnouncementAudience,
  type AudienceScope,
} from "./audience";

/**
 * The acknowledgement report runs as admin_role and therefore bypasses the
 * CMS `announcement-visibility` policy — it has to recompute the target
 * audience with exactly the rules the policy enforces. These tests mirror
 * `apps/cms/src/utils/announcement-audience.test.ts`; if one side changes,
 * the other must too.
 */

const ENGINEERING = 1;
const DESIGN = 2;
const FRONTEND_TEAM = 10;
const BACKEND_TEAM = 11;
const MEMBER_ROLE = 5;
const TEAM_LEAD_ROLE = 6;

const engineer: AudienceScope = {
  roleId: MEMBER_ROLE,
  departmentId: ENGINEERING,
  teamIds: [FRONTEND_TEAM],
};

const designer: AudienceScope = {
  roleId: MEMBER_ROLE,
  departmentId: DESIGN,
  teamIds: [],
};

const announcement = (targeting: AnnouncementAudience): AnnouncementAudience => targeting;

describe("isAnnouncementVisibleTo", () => {
  it("targets everyone when nothing is set", () => {
    expect(isAnnouncementVisibleTo(announcement({ audience: "all" }), designer)).toBe(true);
    expect(isAnnouncementVisibleTo(announcement({}), designer)).toBe(true);
  });

  describe("department", () => {
    const engineeringOnly = announcement({
      audience: "departments",
      department: { id: ENGINEERING },
    });

    it("targets that department", () => {
      expect(isAnnouncementVisibleTo(engineeringOnly, engineer)).toBe(true);
    });

    it("does not target another department", () => {
      expect(isAnnouncementVisibleTo(engineeringOnly, designer)).toBe(false);
    });

    it("does not target a user without a department", () => {
      expect(isAnnouncementVisibleTo(engineeringOnly, { roleId: MEMBER_ROLE, teamIds: [] })).toBe(
        false,
      );
    });

    it("restricts on a department link even on an audience=all announcement", () => {
      // Fail-closed and symmetric with team / audienceRoles: the SET
      // relation is the criterion, the `audience` enum is not consulted.
      const a = announcement({ audience: "all", department: { id: ENGINEERING } });
      expect(isAnnouncementVisibleTo(a, designer)).toBe(false);
      expect(isAnnouncementVisibleTo(a, engineer)).toBe(true);
    });

    it("restricts on a department link when audience is absent entirely", () => {
      const a = announcement({ department: { id: ENGINEERING } });
      expect(isAnnouncementVisibleTo(a, designer)).toBe(false);
      expect(isAnnouncementVisibleTo(a, engineer)).toBe(true);
    });

    it("does not restrict when audience=departments has no department linked", () => {
      // Documented edge case: there is no department to restrict TO.
      const a = announcement({ audience: "departments" });
      expect(isAnnouncementVisibleTo(a, designer)).toBe(true);
    });
  });

  describe("team", () => {
    const frontendOnly = announcement({ audience: "all", team: { id: FRONTEND_TEAM } });

    it("targets members (and leads, who are folded into teamIds)", () => {
      expect(isAnnouncementVisibleTo(frontendOnly, engineer)).toBe(true);
    });

    it("does not target another team", () => {
      expect(isAnnouncementVisibleTo(frontendOnly, { ...engineer, teamIds: [BACKEND_TEAM] })).toBe(
        false,
      );
    });

    it("does not target a user without a team", () => {
      expect(isAnnouncementVisibleTo(frontendOnly, designer)).toBe(false);
    });
  });

  describe("audienceRoles", () => {
    const leadsOnly = announcement({ audienceRoles: [{ id: TEAM_LEAD_ROLE }] });

    it("targets the listed roles", () => {
      expect(isAnnouncementVisibleTo(leadsOnly, { ...engineer, roleId: TEAM_LEAD_ROLE })).toBe(
        true,
      );
    });

    it("does not target other roles", () => {
      expect(isAnnouncementVisibleTo(leadsOnly, engineer)).toBe(false);
    });

    it("does not restrict on an empty list", () => {
      expect(isAnnouncementVisibleTo(announcement({ audienceRoles: [] }), engineer)).toBe(true);
    });
  });

  describe("several criteria", () => {
    const combined = announcement({
      audience: "departments",
      department: { id: ENGINEERING },
      team: { id: FRONTEND_TEAM },
      audienceRoles: [{ id: TEAM_LEAD_ROLE }],
    });

    it("requires all of them", () => {
      expect(isAnnouncementVisibleTo(combined, { ...engineer, roleId: TEAM_LEAD_ROLE })).toBe(true);
      // right department + role, wrong team
      expect(
        isAnnouncementVisibleTo(combined, {
          roleId: TEAM_LEAD_ROLE,
          departmentId: ENGINEERING,
          teamIds: [BACKEND_TEAM],
        }),
      ).toBe(false);
      // right team + role, wrong department
      expect(
        isAnnouncementVisibleTo(combined, {
          roleId: TEAM_LEAD_ROLE,
          departmentId: DESIGN,
          teamIds: [FRONTEND_TEAM],
        }),
      ).toBe(false);
    });
  });

  describe("unknown scope (null)", () => {
    it("matches only untargeted announcements", () => {
      expect(isAnnouncementVisibleTo(announcement({ audience: "all" }), null)).toBe(true);
      expect(
        isAnnouncementVisibleTo(
          announcement({ audience: "departments", department: { id: ENGINEERING } }),
          null,
        ),
      ).toBe(false);
      expect(isAnnouncementVisibleTo(announcement({ team: { id: FRONTEND_TEAM } }), null)).toBe(
        false,
      );
      expect(
        isAnnouncementVisibleTo(announcement({ audienceRoles: [{ id: MEMBER_ROLE }] }), null),
      ).toBe(false);
    });
  });
});

describe("teamIdsByUser", () => {
  it("counts members and the lead, without duplicates", () => {
    const index = teamIdsByUser([
      { id: FRONTEND_TEAM, lead: { id: 1 }, members: [{ id: 2 }, { id: 3 }] },
      // The lead is often not listed among the members (production data
      // has empty member lists but a lead on every team).
      { id: BACKEND_TEAM, lead: { id: 3 }, members: [] },
      // A lead who is also a member must not produce a duplicate entry.
      { id: 12, lead: { id: 2 }, members: [{ id: 2 }] },
    ]);
    expect(index.get(1)).toEqual([FRONTEND_TEAM]);
    expect(index.get(2)).toEqual([FRONTEND_TEAM, 12]);
    expect(index.get(3)).toEqual([FRONTEND_TEAM, BACKEND_TEAM]);
    expect(index.get(99)).toBeUndefined();
  });

  it("tolerates teams without lead or members", () => {
    expect(teamIdsByUser([{ id: FRONTEND_TEAM }]).size).toBe(0);
    expect(teamIdsByUser([{ id: FRONTEND_TEAM, lead: null, members: null }]).size).toBe(0);
  });
});
