import { describe, expect, it } from "vitest";
import { ROLE_PRIVILEGE_ORDER, type RoleType } from "../bootstrap/roles";
import type { EntraDefaultRole, EntraGroupRule } from "./config";
import type { GraphResult } from "./graph";
import {
  DRY_RUN_ROLE_CAP,
  decideRoleWrite,
  resolveEntraRole,
  type RoleResolution,
  type RoleResolutionInput,
  type UserRoleState,
} from "./roles";

/**
 * D-ENTRA-01 spec H (resolveEntraRole) and I (decideRoleWrite). Fake group
 * ids only.
 */
const ADMINS = "00000000-0000-4000-8000-00000000000a";
const EDITORS = "00000000-0000-4000-8000-00000000000e";
const NESTED = "00000000-0000-4000-8000-0000000000ff";

const member = { ok: true, data: { userType: "Member" } } as const;
const b2bGuest = { ok: true, data: { userType: "Guest" } } as const;
const meFailed = { ok: false, reason: 403 } as const;

const groupsOk = (...ids: string[]): GraphResult<string[]> => ({ ok: true, data: ids });

function resolve(input: Partial<RoleResolutionInput> = {}): RoleResolution {
  return resolveEntraRole({
    claimRoles: [],
    me: member,
    groups: null,
    groupRules: [],
    defaultRole: "member",
    ...input,
  });
}

const rules: EntraGroupRule[] = [
  { role: "admin_role", groupId: ADMINS },
  { role: "editor", groupId: EDITORS },
  { role: "team_lead", groupId: NESTED },
];

describe("resolveEntraRole (spec H)", () => {
  it("maps an app role", () => {
    expect(resolve({ claimRoles: ["Intranet.Editor"] })).toEqual({
      kind: "role",
      role: "editor",
      via: ["approle:Intranet.Editor"],
    });
  });

  it("maps a configured group", () => {
    expect(resolve({ groupRules: rules, groups: groupsOk(NESTED) })).toEqual({
      kind: "role",
      role: "team_lead",
      via: [`group:${NESTED}`],
    });
  });

  it("gives the highest privilege of app roles and groups, in either order", () => {
    const orders: string[][] = [
      ["Intranet.Member", "Intranet.DepartmentHead", "Intranet.Guest"],
      ["Intranet.Guest", "Intranet.DepartmentHead", "Intranet.Member"],
    ];
    for (const claimRoles of orders) {
      expect(resolve({ claimRoles })).toMatchObject({ kind: "role", role: "department_head" });
      expect(resolve({ claimRoles, groupRules: rules, groups: groupsOk(EDITORS) })).toEqual({
        kind: "role",
        role: "editor",
        via: [`group:${EDITORS}`],
      });
      expect(
        resolve({ claimRoles: [...claimRoles, "Intranet.Admin"], groupRules: rules, groups: groupsOk(EDITORS) }),
      ).toEqual({ kind: "role", role: "admin_role", via: ["approle:Intranet.Admin"] });
    }
    // Every role outranks the ones after it.
    for (let i = 0; i < ROLE_PRIVILEGE_ORDER.length; i++) {
      const higher = ROLE_PRIVILEGE_ORDER[i];
      const groupRules = ROLE_PRIVILEGE_ORDER.slice(i).map((role, n) => ({
        role,
        groupId: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`,
      }));
      const all = groupsOk(...groupRules.map((rule) => rule.groupId).reverse());
      expect(resolve({ groupRules, groups: all })).toMatchObject({ role: higher });
    }
  });

  it("lists every source of the winning role", () => {
    const twice = [...rules, { role: "editor" as RoleType, groupId: NESTED }];
    expect(
      resolve({ claimRoles: ["Intranet.Editor"], groupRules: twice, groups: groupsOk(EDITORS, NESTED) }),
    ).toEqual({
      kind: "role",
      role: "editor",
      via: ["approle:Intranet.Editor", `group:${EDITORS}`, `group:${NESTED}`],
    });
  });

  it("never matches by name: an app role or group name that is not configured does nothing", () => {
    expect(resolve({ claimRoles: ["Intranet-Admins", "intranet.admin", "Admin", "admin_role"] })).toEqual({
      kind: "role",
      role: "member",
      via: ["default"],
    });
    // A group the user is in but that ENTRA_GROUP_ROLES does not name.
    expect(resolve({ groupRules: rules, groups: groupsOk() })).toMatchObject({ role: "member" });
    // Prototype keys are no app roles.
    expect(resolve({ claimRoles: ["constructor", "__proto__", "toString"] })).toMatchObject({
      via: ["default"],
    });
  });

  it("answers unknown when a configured group check failed, even with an app role", () => {
    for (const groups of [{ ok: false, reason: 429 } as const, { ok: false, reason: "timeout" } as const, null]) {
      expect(resolve({ claimRoles: ["Intranet.Member"], groupRules: rules, groups })).toEqual({
        kind: "unknown",
      });
    }
  });

  it("denies an external (B2B) guest without a match, admits one with Intranet.Guest", () => {
    expect(resolve({ me: b2bGuest })).toEqual({ kind: "deny" });
    expect(resolve({ me: b2bGuest, defaultRole: "guest" })).toEqual({ kind: "deny" });
    expect(resolve({ me: b2bGuest, claimRoles: ["Intranet.Guest"] })).toEqual({
      kind: "role",
      role: "guest",
      via: ["approle:Intranet.Guest"],
    });
  });

  it("answers unknown without /me and without a match", () => {
    expect(resolve({ me: meFailed })).toEqual({ kind: "unknown" });
    expect(resolve({ me: { ok: false, reason: "timeout" } })).toEqual({ kind: "unknown" });
    // A match does not need /me.
    expect(resolve({ me: meFailed, claimRoles: ["Intranet.TeamLead"] })).toMatchObject({
      role: "team_lead",
    });
  });

  it("gives a tenant member without a match ENTRA_DEFAULT_ROLE", () => {
    const cases: [EntraDefaultRole, RoleResolution][] = [
      ["member", { kind: "role", role: "member", via: ["default"] }],
      ["guest", { kind: "role", role: "guest", via: ["default"] }],
      ["deny", { kind: "deny" }],
    ];
    for (const [defaultRole, expected] of cases) {
      expect(resolve({ defaultRole })).toEqual(expected);
    }
  });
});

const newUser = null;
const entraUser = (roleType: string | null, entraAppliedRole: string | null = roleType): UserRoleState => ({
  roleType,
  roleSource: "entra",
  entraAppliedRole,
});
const role = (r: RoleType): RoleResolution => ({ kind: "role", role: r, via: ["default"] });
const unknown: RoleResolution = { kind: "unknown" };
const deny: RoleResolution = { kind: "deny" };

describe("decideRoleWrite (spec I): new users", () => {
  it("refuses unknown with 503 and deny with 403", () => {
    for (const mode of ["on", "dry-run"] as const) {
      expect(decideRoleWrite(newUser, unknown, mode)).toMatchObject({
        kind: "reject",
        status: 503,
        error: "unavailable",
      });
      expect(decideRoleWrite(newUser, deny, mode)).toMatchObject({
        kind: "reject",
        status: 403,
        error: "not_assigned",
      });
    }
  });

  it("creates with the resolved role in mode on", () => {
    for (const r of ROLE_PRIVILEGE_ORDER) {
      expect(decideRoleWrite(newUser, role(r), "on")).toEqual({ kind: "create", role: r, audit: `new->${r}` });
    }
  });

  it("caps new users at member in dry-run; member and guest stay", () => {
    expect(DRY_RUN_ROLE_CAP).toBe("member");
    for (const r of ["admin_role", "editor", "department_head", "team_lead"] as const) {
      expect(decideRoleWrite(newUser, role(r), "dry-run")).toEqual({
        kind: "create",
        role: "member",
        audit: `new->member would new->${r}`,
      });
    }
    expect(decideRoleWrite(newUser, role("member"), "dry-run")).toMatchObject({ role: "member" });
    expect(decideRoleWrite(newUser, role("guest"), "dry-run")).toEqual({
      kind: "create",
      role: "guest",
      audit: "new->guest",
    });
  });
});

describe("decideRoleWrite (spec I): existing users", () => {
  it("never writes a manual or pre-existing (null) role, and deny does not apply", () => {
    for (const roleSource of [null, "manual"]) {
      const user: UserRoleState = { roleType: "guest", roleSource, entraAppliedRole: null };
      for (const result of [role("admin_role"), unknown, deny]) {
        for (const mode of ["on", "dry-run"] as const) {
          expect(decideRoleWrite(user, result, mode)).toEqual({ kind: "keep", audit: "manual" });
        }
      }
    }
  });

  it("applies R when the applied role is still current", () => {
    expect(decideRoleWrite(entraUser("member"), role("editor"), "on")).toEqual({
      kind: "update",
      data: { role: "editor", entraAppliedRole: "editor" },
      audit: "member->editor",
    });
    // Demotions too: Entra owns this role.
    expect(decideRoleWrite(entraUser("admin_role"), role("member"), "on")).toMatchObject({
      data: { role: "member", entraAppliedRole: "member" },
    });
    expect(decideRoleWrite(entraUser("editor"), role("editor"), "on")).toEqual({
      kind: "keep",
      audit: "keep",
    });
  });

  it("flips a user an admin re-roled to manual and keeps the role", () => {
    const edited = entraUser("editor", "member");
    for (const result of [role("member"), role("admin_role"), unknown, deny]) {
      expect(decideRoleWrite(edited, result, "on")).toEqual({
        kind: "update",
        data: { roleSource: "manual", entraAppliedRole: null },
        audit: "manual-override",
      });
      expect(decideRoleWrite(edited, result, "dry-run")).toEqual({
        kind: "keep",
        audit: "would manual-override",
      });
    }
    // A removed role is an admin edit too.
    expect(decideRoleWrite(entraUser(null, "member"), role("member"), "on")).toMatchObject({
      audit: "manual-override",
    });
  });

  it("hands a user back to Entra: roleSource entra with no applied role writes R", () => {
    const handedBack = entraUser("guest", null);
    expect(decideRoleWrite(handedBack, role("team_lead"), "on")).toEqual({
      kind: "update",
      data: { role: "team_lead", entraAppliedRole: "team_lead" },
      audit: "guest->team_lead",
    });
    expect(decideRoleWrite(entraUser("member", null), role("member"), "on")).toEqual({
      kind: "update",
      data: { entraAppliedRole: "member" },
      audit: "keep",
    });
  });

  it("never changes a role on unknown (no demotion on 403, 429 or timeout)", () => {
    for (const mode of ["on", "dry-run"] as const) {
      expect(decideRoleWrite(entraUser("admin_role"), unknown, mode)).toEqual({
        kind: "keep",
        audit: "keep",
      });
    }
  });

  it("refuses deny with 403 in both modes", () => {
    for (const mode of ["on", "dry-run"] as const) {
      expect(decideRoleWrite(entraUser("member"), deny, mode)).toMatchObject({
        kind: "reject",
        status: 403,
        error: "not_assigned",
      });
    }
  });

  it("writes nothing for existing users in dry-run, only logs", () => {
    expect(decideRoleWrite(entraUser("member"), role("admin_role"), "dry-run")).toEqual({
      kind: "keep",
      audit: "would member->admin_role",
    });
    expect(decideRoleWrite(entraUser("member", null), role("member"), "dry-run")).toEqual({
      kind: "keep",
      audit: "keep",
    });
    expect(decideRoleWrite(entraUser("guest", null), role("member"), "dry-run")).toEqual({
      kind: "keep",
      audit: "would guest->member",
    });
  });
});
