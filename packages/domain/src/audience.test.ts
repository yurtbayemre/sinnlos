import { describe, expect, it } from "vitest";
import {
  AUDIENCE_DEPARTMENTS,
  announcementNeedsRetarget,
  eventNeedsRetarget,
  isAnnouncementTargetedTo,
  isInScopedAudience,
  scopedNeedsRetarget,
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

    it("treats a linked department without an id as matching nobody", () => {
      // An unknown target fails closed instead of dropping the criterion.
      const a = { department: {} } as unknown as AnnouncementTargeting;
      expect(isAnnouncementTargetedTo(a, engineer)).toBe(false);
      expect(isAnnouncementTargetedTo(a, null)).toBe(false);
    });
  });

  describe("D-PT01: restricted without a department or a team", () => {
    const everyone = [engineer, designer, { teamIds: [] }, null];

    it("targets nobody when audience=departments links neither", () => {
      for (const a of [
        announcement({ audience: "departments" }),
        announcement({ audience: "departments", department: null, team: null }),
        announcement({ audience: "departments", department: null, team: null, audienceRoles: [] }),
      ]) {
        for (const scope of everyone) expect(isAnnouncementTargetedTo(a, scope)).toBe(false);
      }
    });

    it("targets nobody even when audience roles remain", () => {
      // Roles narrow; they are no department or team to restrict TO.
      const a = announcement({ audience: "departments", audienceRoles: [{ id: MEMBER_ROLE }] });
      for (const scope of everyone) expect(isAnnouncementTargetedTo(a, scope)).toBe(false);
    });

    it("keeps an audience=departments announcement with a team only for that team", () => {
      const a = announcement({ audience: "departments", team: { id: FRONTEND_TEAM } });
      expect(isAnnouncementTargetedTo(a, engineer)).toBe(true);
      expect(isAnnouncementTargetedTo(a, designer)).toBe(false);
    });

    it("leaves audience=all (or no flag) without targets company-wide", () => {
      for (const a of [
        announcement({ audience: "all" }),
        announcement({ audience: null }),
        announcement({}),
      ]) {
        for (const scope of everyone) expect(isAnnouncementTargetedTo(a, scope)).toBe(true);
      }
    });
  });

  describe("the retargetRequired marker (amendment row A3)", () => {
    const everyone = [
      engineer,
      designer,
      { ...engineer, roleId: TEAM_LEAD_ROLE },
      { roleId: MEMBER_ROLE, departmentId: DESIGN, teamIds: [FRONTEND_TEAM] },
      null,
    ];

    it("targets nobody, whatever criteria remain", () => {
      for (const a of [
        // department plus team, the department deleted: the team remains
        announcement({
          audience: "departments",
          team: { id: FRONTEND_TEAM },
          retargetRequired: true,
        }),
        // department plus team, the team deleted: the department remains
        announcement({
          audience: "departments",
          department: { id: ENGINEERING },
          retargetRequired: true,
        }),
        // department plus roles, the department deleted: the roles remain
        announcement({
          audience: "departments",
          audienceRoles: [{ id: MEMBER_ROLE }],
          retargetRequired: true,
        }),
        // even a company-wide flag with nothing left
        announcement({ audience: "all", retargetRequired: true }),
      ]) {
        for (const scope of everyone) expect(isAnnouncementTargetedTo(a, scope)).toBe(false);
      }
    });

    it("without the marker the remaining criterion would have admitted them", () => {
      // The widening the marker prevents: a Design member of the Frontend
      // team reads a department-plus-team announcement whose department was
      // deleted, and every Engineering member one whose team was deleted.
      const teamLeft = announcement({ audience: "departments", team: { id: FRONTEND_TEAM } });
      expect(
        isAnnouncementTargetedTo(teamLeft, {
          roleId: MEMBER_ROLE,
          departmentId: DESIGN,
          teamIds: [FRONTEND_TEAM],
        }),
      ).toBe(true);
      const departmentLeft = announcement({
        audience: "departments",
        department: { id: ENGINEERING },
      });
      expect(isAnnouncementTargetedTo(departmentLeft, { ...engineer, teamIds: [] })).toBe(true);
    });

    it("reads false and null as no marker", () => {
      const a = announcement({ department: { id: ENGINEERING } });
      for (const retargetRequired of [false, null, undefined]) {
        expect(isAnnouncementTargetedTo({ ...a, retargetRequired }, engineer)).toBe(true);
      }
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

describe("needsRetarget helpers (contract K9)", () => {
  it("names the restricting flag value", () => {
    expect(AUDIENCE_DEPARTMENTS).toBe("departments");
  });

  describe("announcementNeedsRetarget", () => {
    it("is true for the marker, whatever is linked", () => {
      expect(announcementNeedsRetarget({ retargetRequired: true })).toBe(true);
      expect(
        announcementNeedsRetarget({
          audience: "departments",
          department: { id: ENGINEERING },
          team: { id: FRONTEND_TEAM },
          retargetRequired: true,
        }),
      ).toBe(true);
    });

    it("is true for D-PT01 (departments without a department or a team)", () => {
      expect(announcementNeedsRetarget({ audience: "departments" })).toBe(true);
      expect(
        announcementNeedsRetarget({ audience: "departments", department: null, team: null }),
      ).toBe(true);
    });

    it("is false while a department or a team is linked, in any row shape", () => {
      expect(
        announcementNeedsRetarget({ audience: "departments", department: { id: ENGINEERING } }),
      ).toBe(false);
      expect(
        announcementNeedsRetarget({ audience: "departments", team: { documentId: "t" } }),
      ).toBe(false);
    });

    it("is false for a company-wide announcement", () => {
      expect(announcementNeedsRetarget({ audience: "all" })).toBe(false);
      expect(announcementNeedsRetarget({ audience: null, retargetRequired: false })).toBe(false);
      expect(announcementNeedsRetarget({})).toBe(false);
    });

    it("agrees with the predicate: every announcement it flags targets nobody", () => {
      const rows: AnnouncementTargeting[] = [
        { audience: "departments" },
        { audience: "departments", audienceRoles: [{ id: MEMBER_ROLE }] },
        { audience: "all", department: { id: ENGINEERING }, retargetRequired: true },
        { audience: "departments", team: { id: FRONTEND_TEAM }, retargetRequired: true },
      ];
      for (const row of rows) {
        expect(announcementNeedsRetarget(row)).toBe(true);
        for (const scope of [engineer, designer, null]) {
          expect(isAnnouncementTargetedTo(row, scope)).toBe(false);
        }
      }
    });
  });

  describe("isInScopedAudience (one document, quick link, poll or course row)", () => {
    it("lets everyone into a company-wide row", () => {
      expect(isInScopedAudience({ audience: "all", departments: [] }, null)).toBe(true);
      expect(isInScopedAudience({ audience: null }, DESIGN)).toBe(true);
    });

    it("lets only a linked department into a targeted row", () => {
      const row = { audience: "departments", departments: [{ id: DESIGN }] };
      expect(isInScopedAudience(row, DESIGN)).toBe(true);
      expect(isInScopedAudience(row, DESIGN + 1)).toBe(false);
      expect(isInScopedAudience(row, null)).toBe(false);
      // A link restricts whatever the flag says.
      expect(isInScopedAudience({ audience: "all", departments: [{ id: DESIGN }] }, null)).toBe(
        false,
      );
    });

    it("lets nobody into a flagged row without departments", () => {
      expect(isInScopedAudience({ audience: "departments", departments: [] }, DESIGN)).toBe(false);
    });
  });

  describe("scopedNeedsRetarget (document, quick link, poll)", () => {
    it("is true when restricted without a department", () => {
      expect(scopedNeedsRetarget({ audience: "departments" })).toBe(true);
      expect(scopedNeedsRetarget({ audience: "departments", departments: [] })).toBe(true);
      expect(scopedNeedsRetarget({ audience: "departments", departments: null })).toBe(true);
    });

    it("is false while a department is linked, or when company-wide", () => {
      expect(scopedNeedsRetarget({ audience: "departments", departments: [{ id: DESIGN }] })).toBe(
        false,
      );
      expect(scopedNeedsRetarget({ audience: "departments", departments: ["a1b2"] })).toBe(false);
      expect(scopedNeedsRetarget({ audience: "all", departments: [] })).toBe(false);
      expect(scopedNeedsRetarget({ audience: null })).toBe(false);
      expect(scopedNeedsRetarget({})).toBe(false);
    });
  });

  describe("eventNeedsRetarget", () => {
    it("is true when notifyAudience=departments has no department left", () => {
      expect(eventNeedsRetarget({ notifyAudience: "departments" })).toBe(true);
      expect(eventNeedsRetarget({ notifyAudience: "departments", departments: [] })).toBe(true);
    });

    it("is false while a department is linked, or when it notifies everyone", () => {
      expect(
        eventNeedsRetarget({ notifyAudience: "departments", departments: [{ id: DESIGN }] }),
      ).toBe(false);
      expect(eventNeedsRetarget({ notifyAudience: "all", departments: [] })).toBe(false);
      // NULL reads as "all" (rows written before the column existed).
      expect(eventNeedsRetarget({ notifyAudience: null })).toBe(false);
      expect(eventNeedsRetarget({})).toBe(false);
    });

    it("ignores the announcement-style audience key", () => {
      expect(eventNeedsRetarget({ audience: "departments" } as never)).toBe(false);
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
