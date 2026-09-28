import { describe, expect, it } from "vitest";
import { hasAudienceBypass } from "../utils/announcement-audience";
import { PRIVILEGED_ROLE_TYPES, shouldSanitizeForRole } from "../utils/sanitize-user-contact";
import { WRITE_BYPASS_ROLES, isWriteBypassRole } from "../utils/write-allowlist";
import {
  ADMIN,
  AUTHENTICATED,
  GUEST,
  MODERATORS,
  ROLES,
  ROLE_PRIVILEGE_ORDER,
  STAFF_ROLES,
  hasRole,
  isRoleType,
} from "./roles";

/**
 * The cms role vocabulary (roadmap B02). The strings are a contract with
 * the web (lib/roles.ts) and with every users-permissions database: a
 * change here renames a role for real.
 */
describe("role vocabulary (B02)", () => {
  it("keeps the role type strings and their privilege order", () => {
    expect(ROLE_PRIVILEGE_ORDER).toEqual([
      "admin_role",
      "editor",
      "department_head",
      "team_lead",
      "member",
      "guest",
    ]);
    expect(ADMIN).toBe("admin_role");
    expect(GUEST).toBe("guest");
    expect(AUTHENTICATED).toBe("authenticated");
  });

  it("seeds exactly the vocabulary, in privilege order", () => {
    expect(ROLES.map((role) => role.type)).toEqual([...ROLE_PRIVILEGE_ORDER]);
    expect(new Set(ROLES.map((role) => role.name)).size).toBe(ROLES.length);
  });

  it("derives the role sets", () => {
    expect(MODERATORS).toEqual(["admin_role", "editor"]);
    expect(STAFF_ROLES).toEqual(["admin_role", "editor", "department_head", "team_lead", "member"]);
  });

  it("isRoleType accepts the six types only", () => {
    for (const role of ROLE_PRIVILEGE_ORDER) expect(isRoleType(role)).toBe(true);
    for (const value of ["authenticated", "public", "admin", "Admin_role", "", null, undefined, 1]) {
      expect(isRoleType(value), String(value)).toBe(false);
    }
  });

  it("the derived bypass and privilege sets follow it", () => {
    expect([...PRIVILEGED_ROLE_TYPES]).toEqual([...STAFF_ROLES]);
    expect(WRITE_BYPASS_ROLES).toEqual([...MODERATORS]);
    for (const role of [...ROLE_PRIVILEGE_ORDER, AUTHENTICATED]) {
      const moderator = (MODERATORS as readonly string[]).includes(role);
      expect(hasAudienceBypass(role), role).toBe(moderator);
      expect(hasRole({ role: { type: role } }, MODERATORS), role).toBe(moderator);
      expect(isWriteBypassRole(role), role).toBe(moderator);
      expect(shouldSanitizeForRole(role), role).toBe(
        !(STAFF_ROLES as readonly string[]).includes(role),
      );
    }
  });
});

describe("hasRole (PL01)", () => {
  it("matches the caller's role type exactly against the list", () => {
    for (const role of ROLE_PRIVILEGE_ORDER) {
      expect(hasRole({ role: { type: role } }, [role]), role).toBe(true);
      expect(hasRole({ role: { type: role } }, [ADMIN]), role).toBe(role === ADMIN);
      expect(hasRole({ role: { type: role } }, MODERATORS), role).toBe(
        (MODERATORS as readonly string[]).includes(role),
      );
    }
  });

  it("holds no role for lookalikes, missing roles and non-string types", () => {
    const lookalikes = ["Admin_role", "ADMIN_ROLE", "admin", " editor", "editor ", "", "authenticated"];
    for (const type of lookalikes) {
      expect(hasRole({ role: { type } }, MODERATORS), JSON.stringify(type)).toBe(false);
    }
    for (const user of [
      null,
      undefined,
      {},
      { role: null },
      { role: {} },
      { role: { type: null } },
      { role: { type: 1 } },
      { role: { type: ["admin_role"] } },
    ]) {
      expect(hasRole(user, MODERATORS), JSON.stringify(user)).toBe(false);
    }
  });

  it("an empty list admits nobody", () => {
    expect(hasRole({ role: { type: ADMIN } }, [])).toBe(false);
  });
});
