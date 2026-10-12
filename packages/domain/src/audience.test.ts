import { describe, expect, it } from "vitest";
import {
  isAnnouncementTargetedTo,
  teamIdsByUser,
  type AnnouncementTargeting,
  type AudienceScope,
} from "./audience.js";

/**
 * Announcement targeting, the one predicate behind the cms
 * `announcement-visibility` policy (apps/cms/src/utils/
 * announcement-audience.ts, whose test pins the policy's use of it) and the
 * web acknowledgement report (apps/web/src/lib/audience.ts), which runs as
 * admin_role, bypasses the policy and recomputes the target audience.
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

const announcement = (targeting: AnnouncementTargeting): AnnouncementTargeting => targeting;

describe("isAnnouncementTargetedTo", () => {
  it("targets everyone when nothing is set", () => {
    expect(isAnnouncementTargetedTo(announcement({ audience: "all" }), designer)).toBe(true);
    expect(isAnnouncementTargetedTo(announcement({}), designer)).toBe(true);
  });

  describe("department", () => {
    const engineeringOnly = announcement({
      audience: "departments",
      department: { id: ENGINEERING },
    });

    it("targets that department", () => {
      expect(isAnnouncementTargetedTo(engineeringOnly, engineer)).toBe(true);
    });

    it("does not target another department", () => {
      expect(isAnnouncementTargetedTo(engineeringOnly, designer)).toBe(false);
    });

    it("does not target a user without a department", () => {
      expect(isAnnouncementTargetedTo(engineeringOnly, { roleId: MEMBER_ROLE, teamIds: [] })).toBe(
        false,
      );
    });

    it("restricts on a department link even on an audience=all announcement", () => {
      // Fail-closed and symmetric with team / audienceRoles: the SET
      // relation is the criterion, the `audience` enum is not consulted.
      const a = announcement({ audience: "all", department: { id: ENGINEERING } });
      expect(isAnnouncementTargetedTo(a, designer)).toBe(false);
      expect(isAnnouncementTargetedTo(a, engineer)).toBe(true);
    });

    it("restricts on a department link when audience is absent entirely", () => {
      const a = announcement({ department: { id: ENGINEERING } });
      expect(isAnnouncementTargetedTo(a, designer)).toBe(false);
      expect(isAnnouncementTargetedTo(a, engineer)).toBe(true);
    });

    it("does not restrict when audience=departments has no department linked", () => {
      // Documented edge case: there is no department to restrict TO.
      const a = announcement({ audience: "departments" });
      expect(isAnnouncementTargetedTo(a, designer)).toBe(true);
    });
  });

  describe("team", () => {
    const frontendOnly = announcement({ audience: "all", team: { id: FRONTEND_TEAM } });

    it("targets members (and leads, who are folded into teamIds)", () => {
      expect(isAnnouncementTargetedTo(frontendOnly, engineer)).toBe(true);
    });

    it("does not target another team", () => {
      expect(isAnnouncementTargetedTo(frontendOnly, { ...engineer, teamIds: [BACKEND_TEAM] })).toBe(
        false,
      );
    });

    it("does not target a user without a team", () => {
      expect(isAnnouncementTargetedTo(frontendOnly, designer)).toBe(false);
    });
  });

  describe("audienceRoles", () => {
    const leadsOnly = announcement({ audienceRoles: [{ id: TEAM_LEAD_ROLE }] });

    it("targets the listed roles", () => {
      expect(isAnnouncementTargetedTo(leadsOnly, { ...engineer, roleId: TEAM_LEAD_ROLE })).toBe(
        true,
      );
    });

    it("does not target other roles", () => {
      expect(isAnnouncementTargetedTo(leadsOnly, engineer)).toBe(false);
    });

    it("does not restrict on an empty list", () => {
      expect(isAnnouncementTargetedTo(announcement({ audienceRoles: [] }), engineer)).toBe(true);
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
      expect(isAnnouncementTargetedTo(combined, { ...engineer, roleId: TEAM_LEAD_ROLE })).toBe(
        true,
      );
      // right department + role, wrong team
      expect(
        isAnnouncementTargetedTo(combined, {
          roleId: TEAM_LEAD_ROLE,
          departmentId: ENGINEERING,
          teamIds: [BACKEND_TEAM],
        }),
      ).toBe(false);
      // right team + role, wrong department
      expect(
        isAnnouncementTargetedTo(combined, {
          roleId: TEAM_LEAD_ROLE,
          departmentId: DESIGN,
          teamIds: [FRONTEND_TEAM],
        }),
      ).toBe(false);
    });
  });

  describe("unknown scope (null)", () => {
    it("matches only untargeted announcements", () => {
      expect(isAnnouncementTargetedTo(announcement({ audience: "all" }), null)).toBe(true);
      expect(
        isAnnouncementTargetedTo(
          announcement({ audience: "departments", department: { id: ENGINEERING } }),
          null,
        ),
      ).toBe(false);
      expect(isAnnouncementTargetedTo(announcement({ team: { id: FRONTEND_TEAM } }), null)).toBe(
        false,
      );
      expect(
        isAnnouncementTargetedTo(announcement({ audienceRoles: [{ id: MEMBER_ROLE }] }), null),
      ).toBe(false);
    });
  });

  describe("no admin/editor bypass", () => {
    // The scope carries a role ID, never a role type: the predicate cannot
    // tell an admin or an editor from anyone else. The cms decides its read
    // bypass (hasRole(user, MODERATORS)) before it asks; the web report
    // must count an editor from another department as NOT targeted.
    const ADMIN_ROLE = 1;
    const EDITOR_ROLE = 2;

    it("targets an admin or editor only through the announcement's own criteria", () => {
      const engineeringOnly = announcement({ department: { id: ENGINEERING } });
      for (const roleId of [ADMIN_ROLE, EDITOR_ROLE]) {
        expect(isAnnouncementTargetedTo(engineeringOnly, { ...designer, roleId })).toBe(false);
        expect(isAnnouncementTargetedTo(engineeringOnly, { ...engineer, roleId })).toBe(true);
      }
      const leadsOnly = announcement({ audienceRoles: [{ id: TEAM_LEAD_ROLE }] });
      expect(isAnnouncementTargetedTo(leadsOnly, { ...engineer, roleId: ADMIN_ROLE })).toBe(false);
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
