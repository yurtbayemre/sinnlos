import { describe, expect, it } from "vitest";
import {
  AD_POSTER_ROLES,
  ADMIN_ROLES,
  canCreatePolls,
  canPostAds,
  canRsvp,
  isAdmin,
  POLL_CREATOR_ROLES,
  RSVP_ROLES,
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
    allowed: ["admin_role", "editor", "department_head", "team_lead", "member", "authenticated"],
  },
  {
    name: "canPostAds",
    predicate: canPostAds,
    set: AD_POSTER_ROLES,
    allowed: ["admin_role", "editor", "department_head", "team_lead", "member"],
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
