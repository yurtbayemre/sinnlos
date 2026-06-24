import { describe, expect, it } from "vitest";
import { ADMIN_ROLES, isAdmin } from "./roles";

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
