import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CUSTOM_ACTION_GRANTS,
  PERMISSION_MATRIX,
  REVOKED_PERMISSIONS,
  ROLES,
  syncAdvancedSettings,
  syncRolePermissions,
} from "./index";
import { PERMISSION_SCHEMAS, PERMISSION_UID, ROLE_UID } from "./test/org-fixtures.test.helper";
import { createStrapiStub, type Row, type StrapiStub } from "./test/strapi-stub.test.helper";
import { PRIVILEGED_ROLE_TYPES } from "./utils/sanitize-user-contact";

/**
 * The permission bootstrap run against the shared Strapi stub (roadmap S02):
 * the effective role|action set the sync writes on a fresh database, its
 * idempotency, the revocations, and the users-permissions advanced settings
 * it overwrites on every boot. This is the safety net for the bootstrap
 * split and the set-based reconciliation (B01-B04): the snapshot must stay
 * byte-identical through all of them, like infra/diagnostics/prod-perm-diff.sql.
 *
 * The snapshot holds only what OUR sync writes (matrix, user reads, custom
 * actions); users-permissions' own first-boot defaults are not part of it.
 * After a deliberate grant change, update it with
 *   pnpm vitest run apps/cms/src/bootstrap.permissions.test.ts -u
 */

const SNAPSHOT = "./__snapshots__/bootstrap.permissions.txt";

/** Our six roles plus the two users-permissions built-ins, ids 1..8. */
function roleRows(types: readonly string[] = [...ROLES.map((r) => r.type), "authenticated", "public"]): Row[] {
  return types.map((type, index) => ({ id: index + 1, type, name: type }));
}

function permissionStub(permissions: Row[] = [], roles: Row[] = roleRows()): StrapiStub {
  return createStrapiStub({
    schemas: PERMISSION_SCHEMAS,
    tables: { [ROLE_UID]: roles, [PERMISSION_UID]: permissions },
  });
}

/** Every permission row as "roleType|action", sorted (code-unit order). */
function pairsOf(strapi: StrapiStub): string[] {
  const typeById = new Map((strapi.tables[ROLE_UID] ?? []).map((role) => [role.id, role.type]));
  return (strapi.tables[PERMISSION_UID] ?? [])
    .map((row) => `${String(typeById.get((row.role as { id: number }).id))}|${String(row.action)}`)
    .sort();
}

/** One seeded permission row per `roleType|action`. */
function rowsFor(pairs: readonly string[], roles: Row[] = roleRows(), firstId = 5000): Row[] {
  const idByType = new Map(roles.map((role) => [role.type, role.id]));
  return pairs.map((pair, index) => {
    const [type, action] = pair.split("|");
    return { id: firstId + index, action, role: { id: idByType.get(type) as number } };
  });
}

const creates = (strapi: StrapiStub) =>
  strapi.calls.filter((call) => call.uid === PERMISSION_UID && call.method === "create");

const revokedPairs = () =>
  Object.entries(REVOKED_PERMISSIONS).flatMap(([role, actions]) =>
    actions.map((action) => `${role}|${action}`),
  );

describe("syncRolePermissions on a fresh database (S02)", () => {
  it("writes exactly the snapshotted role|action set", async () => {
    const strapi = permissionStub();
    await syncRolePermissions(strapi);
    const pairs = pairsOf(strapi);
    expect(new Set(pairs).size).toBe(pairs.length);
    await expect(`${pairs.join("\n")}\n`).toMatchFileSnapshot(SNAPSHOT);
    expect(strapi.log.info).toHaveBeenCalledWith(
      `[bootstrap] granted ${pairs.length} permission(s) across intranet roles`,
    );
  });

  it("grants nothing to `public` and never a revoked pair", async () => {
    const strapi = permissionStub();
    await syncRolePermissions(strapi);
    const pairs = new Set(pairsOf(strapi));
    expect([...pairs].filter((pair) => pair.startsWith("public|"))).toEqual([]);
    expect(revokedPairs().filter((pair) => pairs.has(pair))).toEqual([]);
  });

  it("grants user.find/findOne/me to every role of the matrix, guest included", async () => {
    const strapi = permissionStub();
    await syncRolePermissions(strapi);
    const pairs = new Set(pairsOf(strapi));
    for (const role of Object.keys(PERMISSION_MATRIX)) {
      for (const action of ["find", "findOne", "me"]) {
        expect(pairs.has(`${role}|plugin::users-permissions.user.${action}`), `${role} ${action}`).toBe(
          true,
        );
      }
    }
  });

  it("creates 0 rows on a second run", async () => {
    const strapi = permissionStub();
    await syncRolePermissions(strapi);
    const before = pairsOf(strapi);
    strapi.calls.length = 0;
    strapi.log.info.mockClear();

    await syncRolePermissions(strapi);
    expect(creates(strapi)).toEqual([]);
    expect(pairsOf(strapi)).toEqual(before);
    expect(strapi.log.info).not.toHaveBeenCalled();
  });

  it("skips a missing role with a warning and grants the others", async () => {
    const roles = roleRows().filter((role) => role.type !== "team_lead");
    const strapi = permissionStub([], roles);
    await syncRolePermissions(strapi);
    expect(pairsOf(strapi).some((pair) => pair.startsWith("team_lead|"))).toBe(false);
    expect(pairsOf(strapi).some((pair) => pair.startsWith("member|"))).toBe(true);
    expect(strapi.log.warn).toHaveBeenCalledWith(
      "[bootstrap] role team_lead not found, skipping permissions",
    );
    expect(strapi.log.warn).toHaveBeenCalledWith(
      "[bootstrap] role team_lead not found, skipping custom action api::event.event.ics",
    );
  });
});

describe("syncRolePermissions revocations (S02)", () => {
  it("deletes every REVOKED_PERMISSIONS pair and keeps rows the code does not manage", async () => {
    const revoked = revokedPairs();
    expect(revoked.length).toBeGreaterThan(0);
    const foreign = [
      // users-permissions' own first-boot defaults
      "authenticated|plugin::users-permissions.auth.logout",
      "public|plugin::users-permissions.auth.callback",
      // a grant added in the admin panel
      "public|api::announcement.announcement.find",
    ];
    const strapi = permissionStub(rowsFor([...revoked, ...foreign]));
    await syncRolePermissions(strapi);

    const pairs = new Set(pairsOf(strapi));
    expect(revoked.filter((pair) => pairs.has(pair))).toEqual([]);
    for (const pair of foreign) expect(pairs.has(pair), pair).toBe(true);
    expect(strapi.log.info).toHaveBeenCalledWith(
      `[bootstrap] revoked ${revoked.length} obsolete permission(s)`,
    );
  });

  it("deletes duplicate rows of a revoked pair too", async () => {
    const pair = "guest|api::kudos.kudos.find";
    const strapi = permissionStub(rowsFor([pair, pair]));
    await syncRolePermissions(strapi);
    expect(pairsOf(strapi)).not.toContain(pair);
    expect(strapi.log.info).toHaveBeenCalledWith("[bootstrap] revoked 2 obsolete permission(s)");
  });
});

describe("role vocabulary of the permission constants (S02)", () => {
  const seeded = ROLES.map((role) => role.type);

  it("matrix role keys are a subset of ROLES plus 'authenticated'", () => {
    const allowed = new Set([...seeded, "authenticated"]);
    expect(Object.keys(PERMISSION_MATRIX).filter((role) => !allowed.has(role))).toEqual([]);
  });

  it("custom grants and revocations only name roles of the matrix", () => {
    const matrixRoles = new Set(Object.keys(PERMISSION_MATRIX));
    const named = [
      ...Object.values(CUSTOM_ACTION_GRANTS).flatMap((grant) => (grant === "*" ? [] : grant)),
      ...Object.keys(REVOKED_PERMISSIONS),
    ];
    expect(named.filter((role) => !matrixRoles.has(role))).toEqual([]);
  });

  it("PRIVILEGED_ROLE_TYPES equals ROLES minus guest", () => {
    expect([...PRIVILEGED_ROLE_TYPES].sort()).toEqual(seeded.filter((t) => t !== "guest").sort());
  });
});

describe("syncAdvancedSettings (S02)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** users-permissions' plugin store for the `advanced` key. */
  function advancedStore(initial: Record<string, unknown> | null) {
    const state: { value: Record<string, unknown> | null } = { value: initial };
    const sets: Record<string, unknown>[] = [];
    const keys: unknown[] = [];
    const strapi = {
      store: (key: unknown) => {
        keys.push(key);
        return {
          get: async () => state.value,
          set: async ({ value }: { value: Record<string, unknown> }) => {
            sets.push(value);
            state.value = value;
          },
        };
      },
      log: { info: vi.fn() },
    };
    return { strapi, sets, keys, state };
  }

  const MANAGED = {
    unique_email: true,
    allow_register: false,
    email_confirmation: false,
    default_role: "member",
  };

  it("writes the managed keys into an empty store (LOCAL_REGISTRATION unset)", async () => {
    vi.stubEnv("LOCAL_REGISTRATION", undefined);
    const { strapi, sets, keys } = advancedStore(null);
    await syncAdvancedSettings(strapi);
    expect(keys).toEqual([{ type: "plugin", name: "users-permissions", key: "advanced" }]);
    expect(sets).toEqual([MANAGED]);
    expect(strapi.log.info).toHaveBeenCalledWith(
      "[bootstrap] users-permissions advanced settings synced (allow_register=false, default_role=member)",
    );
  });

  it("opens local registration only for LOCAL_REGISTRATION=1", async () => {
    for (const [value, allow] of [
      ["1", true],
      ["0", false],
      ["", false],
    ] as const) {
      vi.stubEnv("LOCAL_REGISTRATION", value);
      const { strapi, sets } = advancedStore(null);
      await syncAdvancedSettings(strapi);
      expect(sets[0]?.allow_register, `LOCAL_REGISTRATION=${value}`).toBe(allow);
    }
  });

  it("overwrites the managed keys and keeps foreign keys of an existing store", async () => {
    vi.stubEnv("LOCAL_REGISTRATION", undefined);
    const foreign = {
      email_reset_password: "https://intranet.example.com/reset-password",
      email_confirmation_redirection: "https://intranet.example.com/",
      sendConfirmation: false,
    };
    const { strapi, sets } = advancedStore({
      ...foreign,
      unique_email: false,
      allow_register: true,
      email_confirmation: true,
      default_role: "authenticated",
    });
    await syncAdvancedSettings(strapi);
    expect(sets).toEqual([{ ...foreign, ...MANAGED }]);
  });

  it("writes nothing when the store already matches", async () => {
    vi.stubEnv("LOCAL_REGISTRATION", "1");
    const { strapi, sets } = advancedStore({ extra: 1, ...MANAGED, allow_register: true });
    await syncAdvancedSettings(strapi);
    expect(sets).toEqual([]);
    expect(strapi.log.info).not.toHaveBeenCalled();
  });
});
