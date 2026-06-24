import { describe, expect, it } from "vitest";
import rules, {
  DEFAULT_ROLE,
  resolveRoleType,
  type MsGroup,
} from "./ms-role-map";

/**
 * `resolveRoleType` is the authz boundary that decides every Microsoft
 * login's Strapi role from their Entra group memberships. These tests pin
 * its exact contract: first-match-wins, case-insensitive, matches on either
 * the group objectId or its displayName, and falls back to DEFAULT_ROLE.
 */
describe("resolveRoleType", () => {
  it("maps a known group displayName to its role", () => {
    expect(resolveRoleType([{ displayName: "Intranet-Admins" }])).toBe("admin_role");
    expect(resolveRoleType([{ displayName: "Intranet-Editors" }])).toBe("editor");
    expect(resolveRoleType([{ displayName: "Department-Heads" }])).toBe("department_head");
    expect(resolveRoleType([{ displayName: "Team-Leads" }])).toBe("team_lead");
  });

  it("matches case-insensitively on displayName", () => {
    expect(resolveRoleType([{ displayName: "intranet-admins" }])).toBe("admin_role");
    expect(resolveRoleType([{ displayName: "INTRANET-EDITORS" }])).toBe("editor");
  });

  it("matches when the rule's group is given as the objectId field", () => {
    // The rules ship with names, but Graph may surface a group by objectId.
    // A rule keyed on an objectId must still resolve via the `id` field.
    const idRules: MsGroup[] = [{ id: "Intranet-Admins" }];
    expect(resolveRoleType(idRules)).toBe("admin_role");
  });

  it("falls back to DEFAULT_ROLE for an unknown group", () => {
    expect(resolveRoleType([{ displayName: "Some-Other-Group" }])).toBe(DEFAULT_ROLE);
    expect(DEFAULT_ROLE).toBe("member");
  });

  it("falls back to DEFAULT_ROLE for empty / null / undefined input", () => {
    expect(resolveRoleType([])).toBe(DEFAULT_ROLE);
    expect(resolveRoleType(null)).toBe(DEFAULT_ROLE);
    expect(resolveRoleType(undefined)).toBe(DEFAULT_ROLE);
  });

  it("ignores groups with neither id nor displayName", () => {
    expect(resolveRoleType([{}, { id: undefined, displayName: undefined }])).toBe(
      DEFAULT_ROLE,
    );
  });

  it("honours first-match-wins order across multiple memberships", () => {
    // A user in BOTH Editors and Admins must get the higher-privilege role
    // because the admin rule is listed first in `rules`.
    const groups: MsGroup[] = [
      { displayName: "Intranet-Editors" },
      { displayName: "Intranet-Admins" },
    ];
    expect(resolveRoleType(groups)).toBe("admin_role");
  });

  it("does NOT grant admin to a member of an unrelated group only", () => {
    // Guards against a regression where any group membership escalates.
    const groups: MsGroup[] = [
      { id: "00000000-0000-0000-0000-000000000000", displayName: "All Company" },
    ];
    expect(resolveRoleType(groups)).toBe(DEFAULT_ROLE);
  });

  it("first-match-wins follows declared rule order, not membership order", () => {
    // Team-Leads is declared after Department-Heads; a user in both should
    // get department_head regardless of the order Graph returns them.
    const groups: MsGroup[] = [
      { displayName: "Team-Leads" },
      { displayName: "Department-Heads" },
    ];
    expect(resolveRoleType(groups)).toBe("department_head");
  });

  it("ships exactly the four expected privilege-granting rules", () => {
    // If a rule is added/removed, this forces a conscious test update — the
    // role map is an authz surface, not incidental config.
    expect(rules.map((r) => [r.group, r.role])).toEqual([
      ["Intranet-Admins", "admin_role"],
      ["Intranet-Editors", "editor"],
      ["Department-Heads", "department_head"],
      ["Team-Leads", "team_lead"],
    ]);
  });
});
