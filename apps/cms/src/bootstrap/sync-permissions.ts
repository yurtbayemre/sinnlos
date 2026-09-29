import {
  CUSTOM_ACTION_GRANTS,
  PERMISSION_MATRIX,
  computeDesiredGrants,
  computeRevocations,
  type RoleAction,
} from "./permission-matrix";
import { ROLES } from "./roles";

/**
 * Boot-time I/O for the users-permissions roles and grants (roadmap B01):
 * ensureRoles seeds the six intranet roles, syncRolePermissions converges
 * the permission rows to bootstrap/permission-matrix.ts. Both only ADD
 * roles and grants; revocations are the explicit REVOKED_PERMISSIONS list.
 * Before it writes anything, the sync checks every granted action against
 * the controllers Strapi actually loaded (B04, assertKnownActions); the
 * reconciliation itself is set-based and transactional (B03).
 */

export const ROLE_UID = "plugin::users-permissions.role";
export const PERMISSION_UID = "plugin::users-permissions.permission";

/** A row as the query engine returns it; fields are checked where read. */
export interface StoredRow {
  id: number;
  [key: string]: unknown;
}

/** The slice of `strapi.db.query(uid)` the sync uses. */
export interface BootstrapQuery {
  findMany(params: {
    select?: string[];
    populate?: Record<string, { select?: string[] }>;
  }): Promise<StoredRow[]>;
  create(params: { data: Record<string, unknown> }): Promise<unknown>;
  deleteMany(params: { where: Record<string, unknown> }): Promise<{ count?: number | null }>;
}

/** An api or plugin module as `strapi.apis` / `strapi.plugins` hold it. */
export interface ControllerModule {
  /** Controller name → instance; its own keys are the action names. */
  controllers?: Record<string, object | undefined>;
}

/** The two registries users-permissions derives its action list from. */
export interface ControllerRegistry {
  apis: Record<string, ControllerModule | undefined>;
  plugins: Record<string, ControllerModule | undefined>;
}

/** The slice of the Strapi instance the role seed and the sync touch. */
export interface PermissionSyncHost extends Partial<ControllerRegistry> {
  db: {
    query(uid: string): BootstrapQuery;
    /** Queries inside the callback join the transaction (@strapi/database). */
    transaction<T>(callback: () => Promise<T>): Promise<T>;
  };
  log: { info(message: string): void; warn(message: string): void };
}

/**
 * Every content-API action users-permissions knows (roadmap B04), built the
 * way its own syncPermissions builds it (@strapi/plugin-users-permissions
 * 5.55.1 dist/server/services/users-permissions.js syncPermissions):
 * `api::<api>.<controller>.<action>` from strapi.apis and
 * `plugin::<plugin>.<controller>.<action>` from strapi.plugins, one action
 * per own key of each controller instance. That syncPermissions runs in the
 * plugin's bootstrap, before ours, and deletes every permission row whose
 * action is not in this set; a grant outside it would be re-created and
 * deleted on every boot and would never let a request through.
 */
export function knownActions(registry: ControllerRegistry): Set<string> {
  const actions = new Set<string>();
  const collect = (prefix: "api" | "plugin", modules: ControllerRegistry["apis"]) => {
    for (const [moduleName, module] of Object.entries(modules)) {
      for (const [controllerName, controller] of Object.entries(module?.controllers ?? {})) {
        for (const action of Object.keys(controller ?? {})) {
          actions.add(`${prefix}::${moduleName}.${controllerName}.${action}`);
        }
      }
    }
  };
  collect("api", registry.apis);
  collect("plugin", registry.plugins);
  return actions;
}

/**
 * The granted actions `known` lacks, sorted and unique. REVOKED_PERMISSIONS
 * is not checked: revoking an action that no longer exists is harmless.
 */
export function unknownActions(
  grants: readonly { action: string }[],
  known: ReadonlySet<string>,
): string[] {
  return [...new Set(grants.map((grant) => grant.action))]
    .filter((action) => !known.has(action))
    .sort();
}

const isRecord = (value: unknown): value is Record<string, ControllerModule | undefined> =>
  typeof value === "object" && value !== null;

/**
 * Refuses the boot when a desired grant (PERMISSION_MATRIX, the user reads,
 * CUSTOM_ACTION_GRANTS) names an action no loaded controller has, listing
 * all of them: a typo or a renamed controller method fails the deploy
 * instead of 403ing the feature for everyone. Also refuses when the
 * registries are gone (a Strapi upgrade), instead of skipping the check.
 */
export function assertKnownActions(
  host: Partial<ControllerRegistry>,
  grants: readonly { action: string }[] = computeDesiredGrants(),
): void {
  const { apis, plugins } = host;
  if (!isRecord(apis) || !isRecord(plugins)) {
    throw new Error(
      "[bootstrap] strapi.apis / strapi.plugins not found — refusing to sync permissions without checking the granted actions",
    );
  }
  const unknown = unknownActions(grants, knownActions({ apis, plugins }));
  if (unknown.length > 0) {
    throw new Error(
      `[bootstrap] ${unknown.length} granted action(s) match no loaded controller action: ${unknown.join(", ")}. ` +
        "Fix bootstrap/permission-matrix.ts (a typo, or a controller action that was renamed or removed).",
    );
  }
}

/** Creates every role of ROLES that does not exist yet (by `type`), one read. */
export async function ensureRoles(strapi: PermissionSyncHost): Promise<void> {
  const existing = await strapi.db.query(ROLE_UID).findMany({ select: ["id", "type"] });
  const types = new Set(existing.map((role) => role.type));
  for (const seed of ROLES) {
    if (types.has(seed.type)) continue;
    await strapi.db.query(ROLE_UID).create({ data: { ...seed } });
    strapi.log.info(`[bootstrap] created role ${seed.type}`);
  }
}

/** One permission row as the sync reads it. */
export interface ExistingPermission {
  id: number;
  action: string;
  /** The linked role's type; null for a row without a role. */
  roleType: string | null;
}

/** What one sync writes, and what it only reports. */
export interface PermissionSyncPlan {
  /** Desired pairs without a row, for roles that exist. */
  create: { roleType: string; roleId: number; action: string }[];
  /** Every row of a revoked pair the code does not also want (duplicates included). */
  revokeIds: number[];
  /**
   * Report-only drift: pairs on a managed action (one the code grants or
   * revokes anywhere) that the code does not want and does not revoke,
   * e.g. a grant added in the admin panel. Unique, sorted.
   */
  drift: { roleType: string; action: string }[];
  /** How many distinct actions the code manages. */
  managedActions: number;
}

const pairKey = (roleType: string, action: string) => `${roleType} ${action}`;

/**
 * The set-based reconciliation (roadmap B03), pure. It converges to
 * computeDesiredGrants: a missing desired pair is created, a revoked pair
 * that is not also desired is deleted (the custom grant wins, as in the
 * order the sync always applied), and nothing else is touched.
 */
export function planPermissionSync(input: {
  desired: readonly RoleAction[];
  revocations: readonly RoleAction[];
  roleIdByType: ReadonlyMap<string, number>;
  existing: readonly ExistingPermission[];
}): PermissionSyncPlan {
  const desired = new Set(input.desired.map(({ role, action }) => pairKey(role, action)));
  const revoked = new Set(
    input.revocations
      .map(({ role, action }) => pairKey(role, action))
      .filter((pair) => !desired.has(pair)),
  );
  const managed = new Set([...input.desired, ...input.revocations].map(({ action }) => action));
  const held = new Set<string>();
  const revokeIds: number[] = [];
  const drift = new Map<string, { roleType: string; action: string }>();

  for (const row of input.existing) {
    if (row.roleType === null) continue;
    const pair = pairKey(row.roleType, row.action);
    held.add(pair);
    if (revoked.has(pair)) revokeIds.push(row.id);
    else if (managed.has(row.action) && !desired.has(pair)) {
      drift.set(pair, { roleType: row.roleType, action: row.action });
    }
  }

  const create: PermissionSyncPlan["create"] = [];
  for (const { role, action } of input.desired) {
    const roleId = input.roleIdByType.get(role);
    if (roleId !== undefined && !held.has(pairKey(role, action))) {
      create.push({ roleType: role, roleId, action });
    }
  }

  return {
    create,
    revokeIds: revokeIds.sort((a, b) => a - b),
    drift: [...drift.values()].sort(
      (a, b) => a.roleType.localeCompare(b.roleType) || a.action.localeCompare(b.action),
    ),
    managedActions: managed.size,
  };
}

/** deleteMany binds one parameter per id: stay far below every driver limit. */
export const REVOKE_CHUNK_SIZE = 500;

/** How many drift pairs the boot log names before it summarises. */
const DRIFT_LOG_LIMIT = 50;

const roleTypeOfRow = (row: StoredRow): string | null => {
  const role = row.role;
  if (typeof role !== "object" || role === null) return null;
  const type = (role as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
};

/** The roles that may not exist yet, with the warning today's operators know. */
function warnMissingRoles(strapi: PermissionSyncHost, roleIdByType: ReadonlyMap<string, number>) {
  const matrixRoles = Object.keys(PERMISSION_MATRIX);
  for (const roleType of matrixRoles) {
    if (!roleIdByType.has(roleType)) {
      strapi.log.warn(`[bootstrap] role ${roleType} not found, skipping permissions`);
    }
  }
  for (const [actionKey, grant] of Object.entries(CUSTOM_ACTION_GRANTS)) {
    for (const roleType of grant === "*" ? matrixRoles : grant) {
      if (!roleIdByType.has(roleType)) {
        strapi.log.warn(
          `[bootstrap] role ${roleType} not found, skipping custom action ${actionKey}`,
        );
      }
    }
  }
}

function reportDrift(strapi: PermissionSyncHost, plan: PermissionSyncPlan): void {
  if (plan.drift.length === 0) {
    strapi.log.info(
      `[bootstrap] permission drift: none (report-only check of ${plan.managedActions} managed actions)`,
    );
    return;
  }
  const named = plan.drift
    .slice(0, DRIFT_LOG_LIMIT)
    .map(({ roleType, action }) => `${roleType} ${action}`);
  const more = plan.drift.length - named.length;
  strapi.log.warn(
    `[bootstrap] permission drift (report-only, nothing revoked): ${plan.drift.length} grant(s) on managed actions that the code does not grant: ` +
      `${named.join(", ")}${more > 0 ? `, and ${more} more` : ""}. ` +
      "Compare with infra/diagnostics/prod-perm-diff.sql; to remove one, revoke it in the admin panel or list it in REVOKED_PERMISSIONS.",
  );
}

/**
 * Converges the users-permissions rows to bootstrap/permission-matrix.ts
 * (roadmap B03): one roles read and one permissions read (role populated),
 * the missing pairs and the revocations computed in memory
 * (planPermissionSync), then every write in ONE transaction: a per-row
 * create() for each missing pair and a chunked deleteMany by id for the
 * revocations. A second boot writes nothing. A failure rolls the whole
 * sync back and fails the boot.
 *
 * NEVER createMany: @strapi/database's createMany skips relation
 * attachment, so the rows would lose their role link (permission.role is
 * a link-table relation) and grant nothing.
 *
 * Add-only by design: a grant the code does not want is only REPORTED
 * (reportDrift), unless it is listed in REVOKED_PERMISSIONS. Enforcing the
 * managed subset is an open owner decision.
 */
export async function syncRolePermissions(strapi: PermissionSyncHost): Promise<void> {
  assertKnownActions(strapi);

  const roles = await strapi.db.query(ROLE_UID).findMany({ select: ["id", "type"] });
  const roleIdByType = new Map<string, number>();
  for (const role of roles) {
    if (typeof role.type === "string" && !roleIdByType.has(role.type)) {
      roleIdByType.set(role.type, role.id);
    }
  }
  const rows = await strapi.db.query(PERMISSION_UID).findMany({
    select: ["id", "action"],
    populate: { role: { select: ["id", "type"] } },
  });
  const existing: ExistingPermission[] = rows
    .filter((row) => typeof row.action === "string")
    .map((row) => ({ id: row.id, action: row.action as string, roleType: roleTypeOfRow(row) }));

  warnMissingRoles(strapi, roleIdByType);
  const plan = planPermissionSync({
    desired: computeDesiredGrants(),
    revocations: computeRevocations(),
    roleIdByType,
    existing,
  });

  let revoked = 0;
  if (plan.create.length > 0 || plan.revokeIds.length > 0) {
    await strapi.db.transaction(async () => {
      const permissions = strapi.db.query(PERMISSION_UID);
      for (const { roleId, action } of plan.create) {
        await permissions.create({ data: { action, role: roleId } });
      }
      for (let start = 0; start < plan.revokeIds.length; start += REVOKE_CHUNK_SIZE) {
        const ids = plan.revokeIds.slice(start, start + REVOKE_CHUNK_SIZE);
        const { count } = await permissions.deleteMany({ where: { id: { $in: ids } } });
        revoked += count ?? 0;
      }
    });
  }

  if (revoked > 0) {
    strapi.log.info(`[bootstrap] revoked ${revoked} obsolete permission(s)`);
  }
  if (plan.create.length > 0) {
    strapi.log.info(
      `[bootstrap] granted ${plan.create.length} permission(s) across intranet roles`,
    );
  }
  reportDrift(strapi, plan);
}
