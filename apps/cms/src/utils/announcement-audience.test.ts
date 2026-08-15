import { describe, expect, it } from "vitest";
import {
  hasAudienceBypass,
  isAnnouncementVisible,
  type AnnouncementTargeting,
  type AudienceScope,
} from "./announcement-audience";
import { restrictiveIdFilter } from "./policy-query";

/**
 * The decision half of the `announcement-visibility` policy. Announcement
 * targeting was enforced nowhere before (GitHub issue #9): `audience` /
 * `department` lived in the web query only, `team` / `audienceRoles`
 * nowhere at all. These tests pin the rules the policy now applies.
 */

const ENGINEERING = 1;
const DESIGN = 2;
const FRONTEND_TEAM = 10;
const BACKEND_TEAM = 11;
const MEMBER_ROLE = 5;
const TEAM_LEAD_ROLE = 6;

/** An Engineering member of the Frontend team. */
const engineer: AudienceScope = {
  roleId: MEMBER_ROLE,
  departmentId: ENGINEERING,
  teamIds: [FRONTEND_TEAM],
};

/** A Design member without any team. */
const designer: AudienceScope = {
  roleId: MEMBER_ROLE,
  departmentId: DESIGN,
  teamIds: [],
};

const announcement = (targeting: AnnouncementTargeting): AnnouncementTargeting => targeting;

describe("isAnnouncementVisible", () => {
  describe("no targeting", () => {
    it("shows an audience=all announcement to everyone", () => {
      const a = announcement({ audience: "all" });
      expect(isAnnouncementVisible(a, engineer)).toBe(true);
      expect(isAnnouncementVisible(a, designer)).toBe(true);
    });

    it("shows an announcement without any audience field to everyone", () => {
      expect(isAnnouncementVisible(announcement({}), engineer)).toBe(true);
      expect(isAnnouncementVisible(announcement({ audience: null }), designer)).toBe(true);
    });
  });

  describe("department targeting", () => {
    const engineeringOnly = announcement({
      audience: "departments",
      department: { id: ENGINEERING },
    });

    it("shows it to a member of that department", () => {
      expect(isAnnouncementVisible(engineeringOnly, engineer)).toBe(true);
    });

    it("hides it from another department", () => {
      expect(isAnnouncementVisible(engineeringOnly, designer)).toBe(false);
    });

    it("hides it from a user without a department", () => {
      expect(
        isAnnouncementVisible(engineeringOnly, { roleId: MEMBER_ROLE, teamIds: [] }),
      ).toBe(false);
    });

    it("restricts on a department link even when audience is 'all'", () => {
      // Fail-closed and symmetric with team / audienceRoles: the SET
      // relation is the criterion, the `audience` enum is not consulted.
      // Otherwise flipping the enum back to "all" would silently widen a
      // department-scoped post to the whole company.
      const a = announcement({ audience: "all", department: { id: ENGINEERING } });
      expect(isAnnouncementVisible(a, designer)).toBe(false);
      expect(isAnnouncementVisible(a, engineer)).toBe(true);
    });

    it("restricts on a department link when audience is absent entirely", () => {
      const a = announcement({ department: { id: ENGINEERING } });
      expect(isAnnouncementVisible(a, designer)).toBe(false);
      expect(isAnnouncementVisible(a, engineer)).toBe(true);
    });

    it("does not restrict when audience is 'departments' but no department is linked", () => {
      // Documented edge case: there is no department to restrict TO.
      const a = announcement({ audience: "departments", department: null });
      expect(isAnnouncementVisible(a, designer)).toBe(true);
      expect(isAnnouncementVisible(announcement({ audience: "departments" }), null)).toBe(true);
    });
  });

  describe("team targeting", () => {
    const frontendOnly = announcement({ audience: "all", team: { id: FRONTEND_TEAM } });

    it("shows it to a member of that team", () => {
      expect(isAnnouncementVisible(frontendOnly, engineer)).toBe(true);
    });

    it("shows it to the team lead, who is not listed in team.members", () => {
      // The policy merges `user.teams` with the teams the user leads.
      const lead: AudienceScope = {
        roleId: TEAM_LEAD_ROLE,
        departmentId: ENGINEERING,
        teamIds: [FRONTEND_TEAM],
      };
      expect(isAnnouncementVisible(frontendOnly, lead)).toBe(true);
    });

    it("hides it from someone in another team", () => {
      expect(
        isAnnouncementVisible(frontendOnly, { ...engineer, teamIds: [BACKEND_TEAM] }),
      ).toBe(false);
    });

    it("hides it from someone without any team", () => {
      expect(isAnnouncementVisible(frontendOnly, designer)).toBe(false);
    });
  });

  describe("role targeting", () => {
    const leadsOnly = announcement({
      audience: "all",
      audienceRoles: [{ id: TEAM_LEAD_ROLE }],
    });

    it("shows it to a user holding one of the listed roles", () => {
      expect(isAnnouncementVisible(leadsOnly, { ...engineer, roleId: TEAM_LEAD_ROLE })).toBe(
        true,
      );
    });

    it("hides it from every other role", () => {
      expect(isAnnouncementVisible(leadsOnly, engineer)).toBe(false);
    });

    it("does not restrict on an empty audienceRoles list", () => {
      expect(isAnnouncementVisible(announcement({ audienceRoles: [] }), engineer)).toBe(true);
      expect(isAnnouncementVisible(announcement({ audienceRoles: null }), engineer)).toBe(true);
    });
  });

  describe("combined criteria (AND, not OR)", () => {
    const combined = announcement({
      audience: "departments",
      department: { id: ENGINEERING },
      team: { id: FRONTEND_TEAM },
      audienceRoles: [{ id: TEAM_LEAD_ROLE }],
    });

    it("shows it only when every criterion matches", () => {
      expect(isAnnouncementVisible(combined, { ...engineer, roleId: TEAM_LEAD_ROLE })).toBe(
        true,
      );
    });

    it("hides it when only the department matches", () => {
      expect(
        isAnnouncementVisible(combined, {
          roleId: TEAM_LEAD_ROLE,
          departmentId: ENGINEERING,
          teamIds: [BACKEND_TEAM],
        }),
      ).toBe(false);
    });

    it("hides it when only the team and role match", () => {
      expect(
        isAnnouncementVisible(combined, {
          roleId: TEAM_LEAD_ROLE,
          departmentId: DESIGN,
          teamIds: [FRONTEND_TEAM],
        }),
      ).toBe(false);
    });
  });

  describe("anonymous callers (scope = null)", () => {
    it("see untargeted announcements", () => {
      expect(isAnnouncementVisible(announcement({ audience: "all" }), null)).toBe(true);
    });

    it("see nothing that is department-, team- or role-scoped", () => {
      expect(
        isAnnouncementVisible(
          announcement({ audience: "departments", department: { id: ENGINEERING } }),
          null,
        ),
      ).toBe(false);
      expect(
        isAnnouncementVisible(announcement({ team: { id: FRONTEND_TEAM } }), null),
      ).toBe(false);
      expect(
        isAnnouncementVisible(announcement({ audienceRoles: [{ id: MEMBER_ROLE }] }), null),
      ).toBe(false);
    });
  });
});

describe("hasAudienceBypass", () => {
  it("lets admin_role and editor through", () => {
    expect(hasAudienceBypass("admin_role")).toBe(true);
    expect(hasAudienceBypass("editor")).toBe(true);
  });

  it("does not let any other role — or an unauthenticated caller — bypass", () => {
    for (const role of ["department_head", "team_lead", "member", "guest", "authenticated"]) {
      expect(hasAudienceBypass(role)).toBe(false);
    }
    expect(hasAudienceBypass(undefined)).toBe(false);
    expect(hasAudienceBypass(null)).toBe(false);
  });
});

describe("policy filter for a scope that may see nothing", () => {
  it("stays restrictive instead of failing open", () => {
    // A user targeted by nothing resolves to an EMPTY id list; the filter
    // the policy injects must still exclude everything (sanitizeQuery
    // strips `$in: []`, which would drop the filter and show all rows).
    const rows = [
      { id: 1, audience: "departments", department: { id: ENGINEERING } },
      { id: 2, audience: "all", team: { id: FRONTEND_TEAM } },
    ];
    const visibleIds = rows.filter((row) => isAnnouncementVisible(row, designer)).map((r) => r.id);
    expect(visibleIds).toEqual([]);
    expect(restrictiveIdFilter(visibleIds)).toEqual({ id: { $eq: -1 } });
  });
});
