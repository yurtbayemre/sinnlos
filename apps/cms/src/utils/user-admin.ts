/**
 * User administration in the web (v0.23, deep-dive plan-org-users.md
 * release B; contract @sinnlos/domain user-admin.ts). admin_role only: the
 * custom routes of api/user-management are granted to admin_role and the
 * controller checks the role again.
 *
 * OUTPUT IS AN ALLOWLIST (like api/profile): every read selects its
 * columns, every answer is a fixed DTO; no token, oid, token version or
 * password field leaves this module.
 *
 * EVERY WRITE, in one transaction under ONE directory lock (a reserved
 * version row, like the wiki structure lock; the Entra sign-in's role write
 * takes it too), so two admins, or an admin and a sign-in, cannot race the
 * invariants:
 *   - the caller is read again under the lock: still an unblocked admin_role;
 *   - nobody changes their own role or blocked state (`selfChange`);
 *   - so at least one unblocked admin_role always remains: a write needs
 *     an unblocked admin caller, and the caller is never the target;
 *   - a role change makes the role the intranet's (`roleSource: manual`,
 *     `entraAppliedRole` cleared), so the next Entra sign-in keeps it;
 *     "hand back to Entra" undoes that (the DEPLOYMENT.md procedure);
 *   - department and manager of an Entra-bound user are refused while
 *     Entra's sync owns them (`entraManaged`);
 *   - a manager is never the user or one of their reports (`managerCycle`);
 *   - a block raises the token version (old JWTs stay dead after an
 *     unblock); the users-permissions strategy refuses a blocked user on
 *     every request anyway;
 *   - one audit row (keys only) in the same transaction.
 * Team membership stays on the team (v0.22): this module never writes it.
 *
 * NOT COVERED: panel and Entra writes to users keep their own paths (the
 * panel's `user` form, the `[entra]` sign-in log line).
 */
import {
  FORM_KEY,
  ROLE_PRIVILEGE_ORDER,
  USER_ADMIN_FIELDS,
  USER_ADMIN_PAGE_SIZE,
  isRoleType,
  type RoleType,
  type UserAdminDetail,
  type UserAdminListQuery,
  type UserAdminListResponse,
  type UserAdminRow,
  type UserAdminUpdate,
} from "@sinnlos/domain";
import { errors } from "@strapi/utils";

import { parseEntraConfig } from "../entra/config";
import { isEntraBound } from "../entra/profile";
import {
  bumpTokenVersion,
  type TokenVersionStrapi,
} from "../extensions/users-permissions/strapi-server";
import { ROLE_UID } from "./authoring-checks";
import { DEPARTMENT_UID } from "./authoring-uids";
import { recordAuditEvent, type AuditHost } from "./audit";
import { lockDocument, type DocumentLockHost } from "./document-lock";
import { isDocumentId, parseRowId } from "./entry-id";
import { refuseKeys, USER_UID } from "./write-allowlist";

const ADMIN_ROLE: RoleType = "admin_role";
const LIST_KEYS = ["q", "role", "blocked", "page"];
const MAX_QUERY_LENGTH = 100;
const MAX_PAGE = 10_000;
/** A manager chain longer than this is treated as a cycle (it is one, or data damage). */
const MAX_MANAGER_CHAIN = 200;

export const USER_DIRECTORY_LOCK_UID = "sinnlos::user-directory";
export const USER_DIRECTORY_LOCK_DOCUMENT_ID = "global";

type Row = Record<string, unknown>;

/** The slice of the Strapi instance this module uses. */
export interface UserAdminHost {
  db: {
    query(uid: string): {
      findOne(params: Row): Promise<unknown>;
      findMany(params: Row): Promise<unknown>;
      count(params: Row): Promise<number>;
      update(params: Row): Promise<unknown>;
    };
    transaction<T>(callback: () => Promise<T>): Promise<T>;
  };
}

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const idOf = (value: unknown): number | null =>
  isRecord(value) && typeof value.id === "number" ? value.id : null;

const ROW_SELECT = [
  "id",
  "documentId",
  "username",
  "email",
  "displayName",
  "blocked",
  "roleSource",
  "entraTenantId",
  "createdAt",
];
const ROW_POPULATE = {
  role: { select: ["type"] },
  department: { select: ["documentId", "name"] },
};

/** The list query, or null for a key or value it does not take. */
export function parseUserAdminQuery(raw: Row): UserAdminListQuery | null {
  if (Object.keys(raw).some((key) => !LIST_KEYS.includes(key))) return null;
  const query: UserAdminListQuery = {};
  if (raw.q !== undefined) {
    if (typeof raw.q !== "string" || raw.q.length > MAX_QUERY_LENGTH) return null;
    if (raw.q.trim() !== "") query.q = raw.q.trim();
  }
  if (raw.role !== undefined) {
    if (!isRoleType(raw.role)) return null;
    query.role = raw.role;
  }
  if (raw.blocked !== undefined) {
    if (raw.blocked !== "true" && raw.blocked !== "false") return null;
    query.blocked = raw.blocked;
  }
  if (raw.page !== undefined) {
    const page = parseRowId(raw.page);
    if (page === null || page > MAX_PAGE) return null;
    query.page = page;
  }
  return query;
}

function toRow(row: Row): UserAdminRow {
  const role = isRecord(row.role) ? row.role.type : null;
  const department = row.department;
  return {
    id: row.id as number,
    documentId: text(row.documentId) ?? "",
    displayName: text(row.displayName) || text(row.username) || "",
    email: text(row.email) ?? "",
    role: isRoleType(role) ? role : null,
    roleSource: row.roleSource === "entra" ? "entra" : "manual",
    entraBound: isEntraBound(row),
    blocked: row.blocked === true,
    department:
      isRecord(department) && typeof department.documentId === "string"
        ? { documentId: department.documentId, name: text(department.name) ?? "" }
        : null,
  };
}

/** One page of users, by name. */
export async function listUsers(
  strapi: UserAdminHost,
  query: UserAdminListQuery,
): Promise<UserAdminListResponse> {
  const and: Row[] = [];
  if (query.q) {
    and.push({
      $or: ["displayName", "username", "email"].map((field) => ({
        [field]: { $containsi: query.q },
      })),
    });
  }
  if (query.role) and.push({ role: { type: query.role } });
  if (query.blocked === "true") and.push({ blocked: true });
  if (query.blocked === "false")
    and.push({ $or: [{ blocked: false }, { blocked: { $null: true } }] });
  const where = and.length > 0 ? { $and: and } : {};
  const page = query.page ?? 1;
  const users = strapi.db.query(USER_UID);
  const total = await users.count({ where });
  const rows = (await users.findMany({
    where,
    select: ROW_SELECT,
    populate: ROW_POPULATE,
    orderBy: [{ displayName: "asc" }, { id: "asc" }],
    offset: (page - 1) * USER_ADMIN_PAGE_SIZE,
    limit: USER_ADMIN_PAGE_SIZE,
  })) as Row[];
  return {
    data: rows.map(toRow),
    meta: { page, pageSize: USER_ADMIN_PAGE_SIZE, total },
  };
}

async function loadUser(strapi: UserAdminHost, id: number): Promise<Row | null> {
  const row = await strapi.db.query(USER_UID).findOne({
    where: { id },
    select: ROW_SELECT,
    populate: {
      ...ROW_POPULATE,
      manager: { select: ["id", "displayName", "username"] },
      teams: { select: ["documentId", "name"] },
    },
  });
  return isRecord(row) && typeof row.id === "number" ? row : null;
}

/** What Entra's sync owns for `row` right now. */
function lockedFields(row: Row): UserAdminDetail["locked"] {
  let settings;
  try {
    settings = parseEntraConfig(process.env);
  } catch {
    // The boot refuses an invalid Entra config; a changed env at runtime locks nothing.
    return { department: false, manager: false };
  }
  const bound = settings.enabled && isEntraBound(row);
  return {
    department: bound && settings.enabled && settings.syncDepartment,
    manager: bound && settings.enabled && settings.syncManager,
  };
}

function toDetail(row: Row, callerId: number): UserAdminDetail {
  const manager = row.manager;
  return {
    ...toRow(row),
    manager:
      isRecord(manager) && typeof manager.id === "number"
        ? {
            id: manager.id,
            displayName: text(manager.displayName) || text(manager.username) || "",
          }
        : null,
    teams: (Array.isArray(row.teams) ? row.teams : [])
      .filter(isRecord)
      .filter((team) => typeof team.documentId === "string")
      .map((team) => ({ documentId: team.documentId as string, name: text(team.name) ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name, "de")),
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : (text(row.createdAt) ?? null),
    self: row.id === callerId,
    locked: lockedFields(row),
  };
}

/** One user, or a 404. */
export async function userDetail(
  strapi: UserAdminHost,
  id: number,
  callerId: number,
): Promise<UserAdminDetail> {
  const row = await loadUser(strapi, id);
  if (!row) throw new errors.NotFoundError("Not Found");
  return toDetail(row, callerId);
}

/** The update body: exactly USER_ADMIN_FIELDS with their types, or a 400 naming the rest. */
export function parseUserAdminUpdate(body: unknown): UserAdminUpdate {
  const data = isRecord(body) ? body.data : undefined;
  if (!isRecord(data))
    throw new errors.ValidationError('Missing "data" payload in the request body');
  const keys = Object.keys(data);
  const unknown = keys.filter((key) => !(USER_ADMIN_FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) refuseKeys(unknown);
  if (keys.length === 0) refuseKeys([FORM_KEY], { [FORM_KEY]: "required" });
  const bad: string[] = [];
  const update: UserAdminUpdate = {};
  if ("role" in data) {
    if (isRoleType(data.role) && (ROLE_PRIVILEGE_ORDER as readonly string[]).includes(data.role))
      update.role = data.role;
    else bad.push("role");
  }
  if ("department" in data) {
    if (data.department === null || isDocumentId(data.department))
      update.department = data.department as string | null;
    else bad.push("department");
  }
  if ("manager" in data) {
    const manager = data.manager === null ? null : parseRowId(data.manager);
    if (data.manager === null || manager !== null) update.manager = manager;
    else bad.push("manager");
  }
  if ("blocked" in data) {
    if (typeof data.blocked === "boolean") update.blocked = data.blocked;
    else bad.push("blocked");
  }
  if (bad.length > 0) refuseKeys(bad);
  return update;
}

async function lockDirectory(strapi: UserAdminHost): Promise<void> {
  await lockDocument(
    strapi as unknown as DocumentLockHost,
    USER_DIRECTORY_LOCK_UID,
    USER_DIRECTORY_LOCK_DOCUMENT_ID,
  );
}

const roleTypeOf = (row: Row): string | null => (isRecord(row.role) ? text(row.role.type) : null);

/**
 * The caller is still an unblocked admin_role, read under the directory
 * lock: the request's own check ran on a snapshot, and an admin demoted or
 * blocked meanwhile must not finish a queued write (Codex review).
 */
async function assertActiveAdmin(strapi: UserAdminHost, callerId: number): Promise<void> {
  const caller = await strapi.db.query(USER_UID).findOne({
    where: { id: callerId },
    select: ["id", "blocked"],
    populate: { role: { select: ["type"] } },
  });
  if (!isRecord(caller) || caller.blocked === true || roleTypeOf(caller) !== ADMIN_ROLE)
    throw new errors.ForbiddenError("Forbidden");
}

/** Whether `managerId`'s chain of managers reaches `userId` (or runs too long). */
async function reportsTo(
  strapi: UserAdminHost,
  managerId: number,
  userId: number,
): Promise<boolean> {
  let current: number | null = managerId;
  for (let step = 0; current !== null && step < MAX_MANAGER_CHAIN; step++) {
    if (current === userId) return true;
    const row = await strapi.db.query(USER_UID).findOne({
      where: { id: current },
      select: ["id"],
      populate: { manager: { select: ["id"] } },
    });
    current = isRecord(row) ? idOf(row.manager) : null;
  }
  return current !== null;
}

async function audit(
  strapi: UserAdminHost,
  user: Row,
  callerId: number,
  keys: string[],
): Promise<void> {
  await recordAuditEvent(strapi as unknown as AuditHost, {
    action: "update",
    targetUid: USER_UID,
    targetDocumentId: text(user.documentId) ?? String(user.id),
    actorKind: "user",
    actorUserId: callerId,
    actorClass: "moderator",
    source: "content-api",
    keys: [...keys].sort(),
  });
}

/** PUT /api/user-management/:id (see the module comment). */
export async function updateUser(
  strapi: UserAdminHost,
  callerId: number,
  id: number,
  update: UserAdminUpdate,
): Promise<UserAdminDetail> {
  await strapi.db.transaction(async () => {
    await lockDirectory(strapi);
    await assertActiveAdmin(strapi, callerId);
    const user = await loadUser(strapi, id);
    if (!user) throw new errors.NotFoundError("Not Found");
    const codes: Record<string, string> = {};
    if (user.id === callerId) {
      if (update.role !== undefined) codes.role = "selfChange";
      if (update.blocked !== undefined) codes.blocked = "selfChange";
    }
    const locked = lockedFields(user);
    if (update.department !== undefined && locked.department) codes.department = "entraManaged";
    if (update.manager !== undefined && locked.manager) codes.manager = "entraManaged";
    if (Object.keys(codes).length > 0) refuseKeys(Object.keys(codes), codes);

    const data: Row = {};
    if (update.role !== undefined) {
      const role = await strapi.db
        .query(ROLE_UID)
        .findOne({ where: { type: update.role }, select: ["id"] });
      const roleId = idOf(role);
      if (roleId === null) refuseKeys(["role"]);
      // The intranet owns a hand-set role: the next Entra sign-in keeps it.
      Object.assign(data, { role: roleId, roleSource: "manual", entraAppliedRole: null });
    }
    if (update.department !== undefined) {
      if (update.department === null) data.department = null;
      else {
        const department = await strapi.db
          .query(DEPARTMENT_UID)
          .findOne({ where: { documentId: update.department }, select: ["id"] });
        const departmentId = idOf(department);
        if (departmentId === null) refuseKeys(["department"]);
        data.department = departmentId;
      }
    }
    if (update.manager !== undefined) {
      if (update.manager === null) data.manager = null;
      else {
        if (update.manager === id) refuseKeys(["manager"], { manager: "managerCycle" });
        const exists = await strapi.db.query(USER_UID).count({ where: { id: update.manager } });
        if (exists === 0) refuseKeys(["manager"]);
        if (await reportsTo(strapi, update.manager, id))
          refuseKeys(["manager"], { manager: "managerCycle" });
        data.manager = update.manager;
      }
    }
    if (update.blocked !== undefined) data.blocked = update.blocked;

    const wasBlocked = user.blocked === true;
    await strapi.db.query(USER_UID).update({ where: { id }, data });
    if (update.blocked === true && !wasBlocked)
      await bumpTokenVersion(strapi as unknown as TokenVersionStrapi, id);
    await audit(strapi, user, callerId, Object.keys(update));
  });
  return userDetail(strapi, id, callerId);
}

/** POST /api/user-management/:id/role-to-entra: the next sign-in applies Entra's role. */
export async function handRoleToEntra(
  strapi: UserAdminHost,
  callerId: number,
  id: number,
): Promise<UserAdminDetail> {
  await strapi.db.transaction(async () => {
    await lockDirectory(strapi);
    await assertActiveAdmin(strapi, callerId);
    const user = await loadUser(strapi, id);
    if (!user) throw new errors.NotFoundError("Not Found");
    // Entra may demote at the next sign-in: never one's own role (the last admin stays reachable).
    if (user.id === callerId) refuseKeys(["role"], { role: "selfChange" });
    if (!isEntraBound(user)) refuseKeys([FORM_KEY], { [FORM_KEY]: "notEntraBound" });
    await strapi.db
      .query(USER_UID)
      .update({ where: { id }, data: { roleSource: "entra", entraAppliedRole: null } });
    await audit(strapi, user, callerId, ["roleSource"]);
  });
  return userDetail(strapi, id, callerId);
}
