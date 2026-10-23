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
 *   - the caller is read again under the lock, with their row locked to the
 *     commit: still an unblocked admin_role at the token version the request
 *     was verified at (else 401 session_outdated);
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
 * v0.27 (deep-dive plan-v027-rev2.md), under the same lock and admin check:
 *   - invite: a new local account without a password (e-mail unique across
 *     every provider, case-insensitively; username from the e-mail's local
 *     part, numbered until free), and an invitation link by mail
 *     (utils/password-link.ts, utils/account-mail.ts). The account is
 *     committed first; a failed mail keeps it, and send-link retries;
 *   - send-link: a new invitation (no password yet) or reset link (one set)
 *     for a local account bound to no identity provider;
 *   - reset-mfa: clears another user's second factor and raises their
 *     token version (they enroll again at the next sign-in).
 *
 * NOT COVERED: panel and Entra writes to users keep their own paths (the
 * panel's `user` form, the `[entra]` sign-in log line).
 */
import {
  FORM_KEY,
  ROLE_PRIVILEGE_ORDER,
  USER_ADMIN_FIELDS,
  USER_ADMIN_INVITE_FIELDS,
  USER_ADMIN_PAGE_SIZE,
  isRoleType,
  type RoleType,
  type UserAdminDetail,
  type UserAdminInvite,
  type UserAdminListQuery,
  type UserAdminListResponse,
  type UserAdminRow,
  type UserAdminUpdate,
} from "@sinnlos/domain";
import { errors } from "@strapi/utils";

import { parseEntraConfig } from "../entra/config";
import { emailIndexReady } from "../bootstrap/entra-identity-index";
import { accountMailReady, sendAccountMail, type AccountMailHost } from "./account-mail";
import { clearMfa } from "./mfa";
import { isEnrolled, lockUserRow, versionOf, type MfaHost } from "./mfa-core";
import { refuse } from "./refusal";
import { issueLink, isLocalUnbound, LINK_SELECT, linkPurpose } from "./password-link";
import { localSignInEnabled } from "./sign-in-policy";
import { idpOf } from "../idp/exchange-core";
import { parseOidcConfig } from "../oidc/config";
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
    transaction<T>(
      callback: (scope: { trx: { raw(sql: string, bindings: unknown[]): unknown } }) => Promise<T>,
    ): Promise<T>;
  };
  plugin(name: string): { service(name: string): unknown };
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
  "oidcIssuer",
  "createdAt",
  // v0.27, for the invited and mfa flags only (never in an answer):
  "provider",
  "password",
  "microsoftOid",
  "oidcSubject",
  "totpEnabledAt",
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
    roleSource: row.roleSource === "entra" || row.roleSource === "oidc" ? row.roleSource : "manual",
    idp: idpOf(row),
    blocked: row.blocked === true,
    department:
      isRecord(department) && typeof department.documentId === "string"
        ? { documentId: department.documentId, name: text(department.name) ?? "" }
        : null,
    invited: isLocalUnbound(row) && !text(row.password),
    mfa: isEnrolled(row),
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

/** What the identity provider's sync owns for `row` right now. */
function lockedFields(row: Row): UserAdminDetail["locked"] {
  const idp = idpOf(row);
  try {
    if (idp === "entra") {
      const settings = parseEntraConfig(process.env);
      return {
        department: settings.enabled && settings.syncDepartment,
        manager: settings.enabled && settings.syncManager,
      };
    }
    if (idp === "oidc") {
      const settings = parseOidcConfig(process.env);
      return { department: settings.enabled && settings.departmentClaim !== null, manager: false };
    }
  } catch {
    // The boot refuses an invalid config; a changed env at runtime locks nothing.
  }
  return { department: false, manager: false };
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

type Trx = { raw(sql: string, bindings: unknown[]): unknown };

/**
 * The caller is still an unblocked admin_role at the token version their
 * request was verified at, read under the directory lock with the caller's
 * row locked until the commit (Codex reviews): the request's own check ran
 * on a snapshot, and an admin demoted, blocked or signed out meanwhile (a
 * password change, a set-password link, infra/mfa-reset.sh: writers without
 * the directory lock) must not finish a queued write. Such a write now
 * either commits before this read or waits for this transaction.
 * Lock order: the directory, then the caller's row, then the target's. Every
 * transaction that locks two user rows holds the directory lock first, and
 * none takes the directory lock after a row (the IdP role write: directory,
 * then its row), so the order cannot deadlock.
 */
async function assertActiveAdmin(
  strapi: UserAdminHost,
  trx: Trx,
  callerId: number,
  callerTv: number | undefined,
): Promise<void> {
  await lockUserRow(strapi as unknown as MfaHost, trx, callerId);
  const caller = await strapi.db.query(USER_UID).findOne({
    where: { id: callerId },
    select: ["id", "blocked", "tokenVersion"],
    populate: { role: { select: ["type"] } },
  });
  if (!isRecord(caller) || caller.blocked === true || roleTypeOf(caller) !== ADMIN_ROLE)
    throw new errors.ForbiddenError("Forbidden");
  if (callerTv === undefined || versionOf(caller.tokenVersion) !== callerTv)
    refuse(401, "session_outdated", "The session is out of date; sign in again");
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
  callerTv: number | undefined,
  id: number,
  update: UserAdminUpdate,
): Promise<UserAdminDetail> {
  await strapi.db.transaction(async ({ trx }) => {
    await lockDirectory(strapi);
    await assertActiveAdmin(strapi, trx, callerId, callerTv);
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

/**
 * POST /api/user-management/:id/role-to-entra: the next sign-in applies the
 * identity provider's role (Entra or, since v0.25.0, OIDC; the route keeps its name).
 */
export async function handRoleToEntra(
  strapi: UserAdminHost,
  callerId: number,
  callerTv: number | undefined,
  id: number,
): Promise<UserAdminDetail> {
  await strapi.db.transaction(async ({ trx }) => {
    await lockDirectory(strapi);
    await assertActiveAdmin(strapi, trx, callerId, callerTv);
    const user = await loadUser(strapi, id);
    if (!user) throw new errors.NotFoundError("Not Found");
    // The provider may demote at the next sign-in: never one's own role (the last admin stays reachable).
    if (user.id === callerId) refuseKeys(["role"], { role: "selfChange" });
    const idp = idpOf(user);
    if (idp === null) refuseKeys([FORM_KEY], { [FORM_KEY]: "notEntraBound" });
    await strapi.db
      .query(USER_UID)
      .update({ where: { id }, data: { roleSource: idp, entraAppliedRole: null } });
    await audit(strapi, user, callerId, ["roleSource"]);
  });
  return userDetail(strapi, id, callerId);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TEXT = 255;

/** The invite body: USER_ADMIN_INVITE_FIELDS with their types, or a 400 naming the rest. */
export function parseUserAdminInvite(body: unknown): UserAdminInvite {
  const data = isRecord(body) ? body.data : undefined;
  if (!isRecord(data))
    throw new errors.ValidationError('Missing "data" payload in the request body');
  const unknown = Object.keys(data).filter(
    (key) => !(USER_ADMIN_INVITE_FIELDS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) refuseKeys(unknown);
  const bad: string[] = [];
  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > MAX_TEXT) bad.push("email");
  const invite: UserAdminInvite = { email };
  if (data.displayName !== undefined && data.displayName !== null) {
    if (typeof data.displayName === "string" && data.displayName.trim().length <= MAX_TEXT)
      invite.displayName = data.displayName.trim() || null;
    else bad.push("displayName");
  }
  if (data.role !== undefined) {
    if (isRoleType(data.role) && (ROLE_PRIVILEGE_ORDER as readonly string[]).includes(data.role))
      invite.role = data.role;
    else bad.push("role");
  }
  if (data.department !== undefined) {
    if (data.department === null || isDocumentId(data.department))
      invite.department = data.department as string | null;
    else bad.push("department");
  }
  if (bad.length > 0) refuseKeys(bad);
  return invite;
}

/** A free username from the e-mail's local part (numbered when taken). */
async function freeUsername(strapi: UserAdminHost, email: string): Promise<string> {
  const base =
    email
      .split("@")[0]
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 40) || "user";
  const stem = base.length >= 3 ? base : `${base}-user`;
  for (let n = 1; n <= 1000; n++) {
    const candidate = n === 1 ? stem : `${stem}-${n}`;
    const taken = await strapi.db
      .query(USER_UID)
      .findOne({ where: { username: { $eqi: candidate } }, select: ["id"] });
    if (!taken) return candidate;
  }
  throw new errors.ApplicationError("No free username");
}

async function auditLink(
  strapi: UserAdminHost,
  user: Row,
  callerId: number,
  action: "create" | "update",
  keys: string[],
): Promise<void> {
  await recordAuditEvent(strapi as unknown as AuditHost, {
    action,
    targetUid: USER_UID,
    targetDocumentId: text(user.documentId) ?? String(user.id),
    actorKind: "user",
    actorUserId: callerId,
    actorClass: "moderator",
    source: "content-api",
    keys,
  });
}

/** Refuses when invitations cannot work on this instance. */
function assertLinksPossible(): void {
  if (!localSignInEnabled()) refuseKeys([FORM_KEY], { [FORM_KEY]: "localSignInOff" });
  if (!accountMailReady().ok) refuseKeys([FORM_KEY], { [FORM_KEY]: "mailNotConfigured" });
}

/** A database uniqueness violation (Postgres 23505, SQLite SQLITE_CONSTRAINT_UNIQUE). */
function uniqueViolation(err: unknown): boolean {
  if (!isRecord(err)) return false;
  const code = String(err.code ?? "");
  return (
    code === "23505" ||
    code.startsWith("SQLITE_CONSTRAINT") ||
    /unique constraint/i.test(String(err.message ?? ""))
  );
}

const mailHost = (strapi: UserAdminHost) => strapi as unknown as AccountMailHost;

/** POST /api/user-management/invite (see the module comment). */
export async function inviteUser(
  strapi: UserAdminHost,
  callerId: number,
  callerTv: number | undefined,
  invite: UserAdminInvite,
): Promise<{ id: number; mail: "sent" | "failed" }> {
  assertLinksPossible();
  // rev3 #5: without the e-mail index a second account for an address could slip in.
  if (emailIndexReady() !== true) refuse(409, "email_duplicates_exist");
  let mail: { to: string; token: string; name: string } | null = null;
  let id = 0;
  try {
    await strapi.db.transaction(async ({ trx }) => {
      await lockDirectory(strapi);
      await assertActiveAdmin(strapi, trx, callerId, callerTv);
      const users = strapi.db.query(USER_UID);
      const taken = await users.findOne({
        where: { email: { $eqi: invite.email } },
        select: ["id"],
      });
      if (taken) refuseKeys(["email"], { email: "taken" });
      const role = await strapi.db
        .query(ROLE_UID)
        .findOne({ where: { type: invite.role ?? "member" }, select: ["id"] });
      const roleId = idOf(role);
      if (roleId === null) refuseKeys(["role"]);
      let departmentId: number | null = null;
      if (invite.department) {
        const department = await strapi.db
          .query(DEPARTMENT_UID)
          .findOne({ where: { documentId: invite.department }, select: ["id"] });
        departmentId = idOf(department);
        if (departmentId === null) refuseKeys(["department"]);
      }
      const username = await freeUsername(strapi, invite.email);
      const service = strapi.plugin("users-permissions").service("user") as {
        add(values: Row): Promise<unknown>;
      };
      const created = await service.add({
        username,
        email: invite.email,
        displayName: invite.displayName ?? null,
        provider: "local",
        confirmed: true,
        blocked: false,
        role: roleId,
        department: departmentId,
      });
      const createdId = idOf(created);
      const row =
        createdId === null
          ? null
          : await users.findOne({ where: { id: createdId }, select: LINK_SELECT });
      if (!isRecord(row)) throw new errors.ApplicationError("Invitation not created");
      id = row.id as number;
      const token = await issueLink(strapi as unknown as MfaHost, row, "invite");
      mail = { to: invite.email, token, name: invite.displayName || username };
      await auditLink(strapi, row, callerId, "create", ["invite"]);
    });
  } catch (err) {
    // Another writer (the panel, a first IdP sign-in) took the address meanwhile.
    if (uniqueViolation(err)) refuseKeys(["email"], { email: "taken" });
    throw err;
  }
  const sent = mail
    ? await sendAccountMail(mailHost(strapi), {
        ...(mail as { to: string; token: string; name: string }),
        kind: "invite",
      })
    : false;
  return { id, mail: sent ? "sent" : "failed" };
}

/** POST /api/user-management/:id/send-link: a new invitation or reset link. */
export async function sendLink(
  strapi: UserAdminHost,
  callerId: number,
  callerTv: number | undefined,
  id: number,
): Promise<{ id: number; mail: "sent" | "failed" }> {
  assertLinksPossible();
  let mail: {
    to: string;
    token: string;
    name: string;
    kind: "invite" | "reset";
    locale: unknown;
  } | null = null;
  await strapi.db.transaction(async ({ trx }) => {
    await lockDirectory(strapi);
    await assertActiveAdmin(strapi, trx, callerId, callerTv);
    // rev3 #7: the link is stamped with the version read under the row lock.
    await lockUserRow(strapi as unknown as MfaHost, trx, id);
    const row = await strapi.db.query(USER_UID).findOne({ where: { id }, select: LINK_SELECT });
    if (!isRecord(row)) throw new errors.NotFoundError("Not Found");
    if (!isLocalUnbound(row)) refuseKeys([FORM_KEY], { [FORM_KEY]: "notLocal" });
    if (row.blocked === true) refuseKeys([FORM_KEY], { [FORM_KEY]: "blocked" });
    const kind = linkPurpose(row);
    const token = await issueLink(strapi as unknown as MfaHost, row, kind);
    mail = {
      to: text(row.email) ?? "",
      token,
      name: text(row.displayName) || text(row.username) || "",
      kind,
      locale: row.locale,
    };
    await auditLink(strapi, row, callerId, "update", [
      kind === "invite" ? "invite" : "passwordLink",
    ]);
  });
  const sent = mail ? await sendAccountMail(mailHost(strapi), mail) : false;
  return { id, mail: sent ? "sent" : "failed" };
}

/**
 * POST /api/user-management/:id/reset-mfa: never one's own (the
 * self-service path is disable). The admin's session must still be at the
 * version it was verified at (rev3 #1).
 */
export async function resetUserMfa(
  strapi: UserAdminHost,
  callerId: number,
  callerTv: number | undefined,
  id: number,
): Promise<UserAdminDetail> {
  await strapi.db.transaction(async ({ trx }) => {
    await lockDirectory(strapi);
    await assertActiveAdmin(strapi, trx, callerId, callerTv);
    const user = await loadUser(strapi, id);
    if (!user) throw new errors.NotFoundError("Not Found");
    if (user.id === callerId) refuseKeys([FORM_KEY], { [FORM_KEY]: "selfChange" });
    await clearMfa(strapi as never, trx, id);
    await audit(strapi, user, callerId, ["mfa"]);
  });
  return userDetail(strapi, id, callerId);
}
