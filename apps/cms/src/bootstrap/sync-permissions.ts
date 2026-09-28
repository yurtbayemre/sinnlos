import {
  CUSTOM_ACTION_GRANTS,
  PERMISSION_MATRIX,
  REVOKED_PERMISSIONS,
  USER_READ_ACTIONS,
  USER_READ_EXCLUDED_ROLES,
  USER_UID,
  computeDesiredGrants,
} from "./permission-matrix";
import { ROLES } from "./roles";

/**
 * Boot-time I/O for the users-permissions roles and grants (roadmap B01):
 * ensureRoles seeds the six intranet roles, syncRolePermissions converges
 * the permission rows to bootstrap/permission-matrix.ts. Both only ADD
 * roles and grants; revocations are the explicit REVOKED_PERMISSIONS list.
 * Before it writes anything, the sync checks every granted action against
 * the controllers Strapi actually loaded (B04, assertKnownActions).
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
  findOne(params: { where: Record<string, unknown> }): Promise<StoredRow | null>;
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
  db: { query(uid: string): BootstrapQuery };
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

/** Creates every role of ROLES that does not exist yet (by `type`). */
export async function ensureRoles(strapi: PermissionSyncHost): Promise<void> {
  for (const seed of ROLES) {
    const existing = await strapi.db.query(ROLE_UID).findOne({ where: { type: seed.type } });
    if (!existing) {
      await strapi.db.query(ROLE_UID).create({ data: { ...seed } });
      strapi.log.info(`[bootstrap] created role ${seed.type}`);
    }
  }
}

async function ensureActionPermission(
  strapi: PermissionSyncHost,
  roleId: number,
  actionKey: string,
): Promise<boolean> {
  const existing = await strapi.db
    .query(PERMISSION_UID)
    .findOne({ where: { action: actionKey, role: roleId } });
  if (existing) return false;
  await strapi.db.query(PERMISSION_UID).create({ data: { action: actionKey, role: roleId } });
  return true;
}

async function findRole(strapi: PermissionSyncHost, roleType: string): Promise<StoredRow | null> {
  return strapi.db.query(ROLE_UID).findOne({ where: { type: roleType } });
}

export async function syncRolePermissions(strapi: PermissionSyncHost): Promise<void> {
  assertKnownActions(strapi);
  let granted = 0;
  for (const [roleType, matrix] of Object.entries(PERMISSION_MATRIX)) {
    const role = await findRole(strapi, roleType);
    if (!role) {
      strapi.log.warn(`[bootstrap] role ${roleType} not found, skipping permissions`);
      continue;
    }
    for (const [uid, actions] of Object.entries(matrix)) {
      if (!actions) continue;
      for (const action of actions) {
        const created = await ensureActionPermission(strapi, role.id, `${uid}.${action}`);
        if (created) granted++;
      }
    }
    // Grant read access to users so populated relations work
    // (except for the roles excluded above — see USER_READ_EXCLUDED_ROLES).
    if (!USER_READ_EXCLUDED_ROLES.includes(roleType)) {
      for (const action of USER_READ_ACTIONS) {
        const created = await ensureActionPermission(strapi, role.id, `${USER_UID}.${action}`);
        if (created) granted++;
      }
    }
  }

  // Remove permissions that older bootstrap versions handed out.
  let revoked = 0;
  for (const [roleType, actions] of Object.entries(REVOKED_PERMISSIONS)) {
    const role = await findRole(strapi, roleType);
    if (!role) continue;
    for (const action of actions) {
      const { count } = await strapi.db
        .query(PERMISSION_UID)
        .deleteMany({ where: { action, role: role.id } });
      revoked += count ?? 0;
    }
  }
  if (revoked > 0) {
    strapi.log.info(`[bootstrap] revoked ${revoked} obsolete permission(s)`);
  }

  // Custom (non-CRUD) route actions — see CUSTOM_ACTION_GRANTS.
  const allRoleTypes = Object.keys(PERMISSION_MATRIX);
  for (const [actionKey, grant] of Object.entries(CUSTOM_ACTION_GRANTS)) {
    const roleTypes = grant === "*" ? allRoleTypes : grant;
    for (const roleType of roleTypes) {
      const role = await findRole(strapi, roleType);
      if (!role) {
        strapi.log.warn(
          `[bootstrap] role ${roleType} not found, skipping custom action ${actionKey}`,
        );
        continue;
      }
      const created = await ensureActionPermission(strapi, role.id, actionKey);
      if (created) granted++;
    }
  }

  if (granted > 0) {
    strapi.log.info(`[bootstrap] granted ${granted} permission(s) across intranet roles`);
  }
}
