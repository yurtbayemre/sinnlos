/**
 * The identity-provider-neutral half of a sign-in exchange (plan-oidc.md,
 * v0.24.0), taken out of entra/provision.ts without a change of behaviour.
 * The Entra exchange is its only caller until v0.25.0 adds OIDC; the
 * reasons behind each step are in entra/provision.ts's header (D-ENTRA-01
 * spec D, F, I, N). Here:
 *   - the shared-secret check, the outcome types and the error label that
 *     log lines may show;
 *   - admitIdentity: the row of a verified identity, found by its unique
 *     (issuer, subject) pair, never by e-mail. A new identity whose address
 *     another row uses gets 409 account_exists; concurrent first sign-ins
 *     race on the identity's unique index and the loser continues with the
 *     winner's row; a blocked row gets 403. The provider's role decision
 *     (`decide`) and its write run in ONE short transaction: around the
 *     insert of a new row (row and role link commit together), and on a
 *     fresh, on Postgres locked read of an existing row;
 *   - issueSession: the Strapi JWT and its exp.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { withIssueClaims } from "../extensions/users-permissions/strapi-server";
import type { RoleType } from "../bootstrap/roles";
// The profile rules were written for Entra and are pure; every provider shares them.
import { pickDepartment } from "../entra/profile";
import { lockDocument, type DocumentLockHost } from "../utils/document-lock";
import { USER_DIRECTORY_LOCK_DOCUMENT_ID, USER_DIRECTORY_LOCK_UID } from "../utils/user-admin";
import { writeWhileUnblocked } from "../utils/unblocked-write";

export const USER_UID = "plugin::users-permissions.user";
export const ROLE_UID = "plugin::users-permissions.role";

/** The error codes of an exchange; the web maps them to /sign-in?error=<provider>_<code>. */
export type ExchangeError =
  | "unauthorized"
  | "invalid"
  | "account_exists"
  | "not_assigned"
  | "blocked"
  | "unavailable"
  /** OIDC only: no e-mail address with email_verified true in the ID token. */
  | "email_unverified";

export interface ExchangeSuccess {
  jwt: string;
  /** exp of the jwt, epoch seconds. */
  expiresAt: number;
  user: { id: number; displayName: string; email: string };
}

export type ExchangeOutcome =
  | { status: 200; body: ExchangeSuccess }
  | { status: 400 | 401 | 403 | 409 | 503; body: { error: ExchangeError } };

export type Row = Record<string, unknown> & { id: number };

interface Query {
  findOne(params: Record<string, unknown>): Promise<Row | null>;
  findMany(params: Record<string, unknown>): Promise<Row[]>;
  create(params: { data: Record<string, unknown> }): Promise<Row>;
  update(params: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<Row | null>;
}

/** The query builder slice that locks a user row (Postgres). */
interface LockQuery {
  select(columns: string[]): LockQuery;
  where(where: Record<string, unknown>): LockQuery;
  forUpdate(): LockQuery;
  execute(): Promise<unknown>;
}

/** The slice of the Strapi instance an exchange uses. */
export interface ExchangeHost {
  db: {
    query(uid: string): Query;
    /**
     * One transaction around `callback`: every query inside joins it
     * (@strapi/database keeps it in AsyncLocalStorage, and a nested
     * transaction() reuses it), commit on return, rollback on a throw.
     */
    transaction<T>(callback: () => Promise<T>): Promise<T>;
    queryBuilder(uid: string): LockQuery;
    /** 'postgres' or 'sqlite'. */
    dialect: { client: string };
  };
  documents(uid: string): {
    findMany(params: Record<string, unknown>): Promise<{ documentId: string }[]>;
    update(params: { documentId: string; data: Record<string, unknown> }): Promise<unknown>;
  };
  plugin(name: string): { service(name: string): unknown };
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

export interface ExchangeRequest {
  /** The exchange-secret header, as received. */
  secret: unknown;
  body: unknown;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const stringOf = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

export const fail = (
  status: 400 | 401 | 403 | 409 | 503,
  error: ExchangeError,
): ExchangeOutcome => ({ status, body: { error } });

/** Constant-time comparison of the header with the configured secret. */
export function secretMatches(header: unknown, secret: string): boolean {
  if (typeof header !== "string" || header === "" || secret === "") return false;
  const given = createHash("sha256").update(header, "utf8").digest();
  const expected = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(given, expected);
}

/** exp of a JWT the cms just issued (payload decoded, not verified). */
function jwtExp(jwt: string): number | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const exp = (
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }
    ).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/** The Strapi JWT of a signed-in user, for `ttl` (jsonwebtoken's expiresIn, e.g. "12h"). */
export async function issueSession(
  strapi: ExchangeHost,
  userId: number,
  ttl: string,
  ttlSeconds: number,
): Promise<{ jwt: string; expiresAt: number }> {
  const jwtService = strapi.plugin("users-permissions").service("jwt") as {
    issue(payload: { id: number }, options: { expiresIn: string }): string | Promise<string>;
  };
  // v0.27: an identity-provider session (am "idp"): the provider owns MFA.
  const jwt = await withIssueClaims({ userId, am: "idp" }, () =>
    jwtService.issue({ id: userId }, { expiresIn: ttl }),
  );
  return { jwt, expiresAt: jwtExp(jwt) ?? Math.floor(Date.now() / 1000) + ttlSeconds };
}

const SAFE_LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * What a log line may say about an error: its code (a Postgres SQLSTATE, a
 * SQLite or Node code) or its class name, never its message. knex prefixes
 * the message of a failed query with the SQL and every bound value, i.e.
 * the e-mail, name, job title, phone, office and identity of the profile
 * being written (spec N: no profile payload in a log line).
 */
export function errorLabel(err: unknown): string {
  const code =
    typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof code === "number" && Number.isFinite(code)) return String(code);
  if (typeof code === "string" && SAFE_LABEL.test(code)) return code;
  const name = err instanceof Error ? err.name : "";
  return SAFE_LABEL.test(name) ? name : "unknown";
}

/** A broken invariant of an exchange; its code is what the log line shows. */
export class ExchangeInvariantError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ExchangeInvariantError";
    this.code = code;
  }
}

/** The role fields of an existing user row. */
export interface UserRoleState {
  /** The current role's type (null without a role). */
  roleType: string | null;
  roleSource: string | null;
  entraAppliedRole: string | null;
}

export type RoleWriteDecision =
  /** Refuse the sign-in. */
  | { kind: "reject"; status: 403; error: "not_assigned"; audit: string }
  | { kind: "reject"; status: 503; error: "unavailable"; audit: string }
  /** New user: create with this role (the provider's newRow sets the ownership fields). */
  | { kind: "create"; role: RoleType; audit: string }
  /** Existing user: write these fields (and the role when `role` is set). */
  | {
      kind: "update";
      data: { role?: RoleType; entraAppliedRole?: RoleType | null; roleSource?: "manual" };
      audit: string;
    }
  /** Existing user: no role field changes. */
  | { kind: "keep"; audit: string };

/** The fields of the audit line admitIdentity fills. */
export interface AdmissionAudit {
  user: string;
  result: "created" | "existing" | "conflict" | "denied" | "blocked" | "unavailable";
  role: string;
}

/** One verified identity, as the provider's exchange describes it. */
export interface Admission {
  /** Log prefix, e.g. "[entra]". */
  log: string;
  /** How log lines name the identity, e.g. "oid=1a2b3c4d" (never the full id). */
  ref: string;
  /** The identity's unique pair as a where clause, e.g. { entraTenantId, microsoftOid }. */
  identity: Record<string, unknown>;
  /** The columns and relations the caller reads from the admitted row. */
  select: string[];
  populate: Record<string, unknown>;
  /** The address of a new identity; null refuses a new identity (503). */
  email: string | null;
  /** The role decision: `user` null for a new identity, else the locked fresh row. */
  decide(user: UserRoleState | null): RoleWriteDecision;
  /** A new row's columns besides email, role, confirmed and blocked. */
  newRow(role: RoleType, email: string): Record<string, unknown>;
}

type Refused = { kind: "refused"; status: 403 | 409 | 503; error: ExchangeError };

export type Admitted = Refused | { kind: "ok"; user: Row; created: boolean };

/**
 * The admitted row (read with `select`/`populate`) and whether this
 * exchange created it, or the refusal. Fills audit.user, .result and .role.
 */
export async function admitIdentity(
  strapi: ExchangeHost,
  admission: Admission,
  audit: AdmissionAudit,
): Promise<Admitted> {
  const users = strapi.db.query(USER_UID);
  const findIdentity = () =>
    users.findOne({
      where: admission.identity,
      select: admission.select,
      populate: admission.populate,
    });

  let user = await findIdentity();
  let created = false;
  if (!user) {
    const email = admission.email;
    if (email === null) {
      strapi.log.warn(
        `${admission.log} exchange refused: no e-mail address for a new identity (${admission.ref})`,
      );
      audit.result = "unavailable";
      return { kind: "refused", status: 503, error: "unavailable" };
    }
    // No automatic linking by e-mail (the nOAuth risk class): an admin binds
    // the existing row by entering the identity on it, after checking whose
    // it is (a self-registered address is not verified).
    const taken = await users.findOne({ where: { email: { $eqi: email } }, select: ["id"] });
    if (taken) {
      // The row with this address can be this very identity: a concurrent
      // first sign-in of the same person created it between the lookup
      // above and this check. Continue as that existing user (spec F); only
      // an address of ANOTHER row is a conflict.
      user = await findIdentity();
      if (!user) {
        audit.result = "conflict";
        return { kind: "refused", status: 409, error: "account_exists" };
      }
      strapi.log.info(
        `${admission.log} concurrent first sign-in (${admission.ref}): continuing with the existing row`,
      );
    } else {
      const outcome = await createIdentity(strapi, admission, email, audit);
      if (outcome.kind === "refused") return outcome;
      created = outcome.created;
      user = await findIdentity();
      if (!user) throw new ExchangeInvariantError("readback_failed");
    }
  }

  audit.user = String(user.id);
  if (created) {
    audit.result = "created";
    return { kind: "ok", user, created };
  }
  if (user.blocked === true) {
    audit.result = "blocked";
    audit.role = "keep";
    return { kind: "refused", status: 403, error: "blocked" };
  }
  const step = await writeRole(strapi, user.id, admission);
  audit.role = step.audit;
  if (step.kind === "refused") {
    audit.result = step.status === 403 ? "denied" : "unavailable";
    return { kind: "refused", status: step.status, error: step.error };
  }
  audit.result = "existing";
  return { kind: "ok", user, created };
}

type CreateOutcome =
  | Refused
  /** created false: a concurrent first sign-in of the same person won the unique index. */
  | { kind: "row"; created: boolean };

/** Spec F: the row of a new identity whose address no row uses. */
async function createIdentity(
  strapi: ExchangeHost,
  admission: Admission,
  email: string,
  audit: AdmissionAudit,
): Promise<CreateOutcome> {
  const users = strapi.db.query(USER_UID);
  const decision = admission.decide(null);
  audit.role = decision.audit;
  if (decision.kind === "reject") {
    audit.result = decision.status === 403 ? "denied" : "unavailable";
    return { kind: "refused", status: decision.status, error: decision.error };
  }
  if (decision.kind !== "create")
    throw new ExchangeInvariantError(`new_user_decision_${decision.kind}`);
  const roleId = await roleIdOf(strapi, decision.role);
  if (roleId === null) {
    strapi.log.error(`${admission.log} role ${decision.role} does not exist; refusing the sign-in`);
    audit.result = "unavailable";
    return { kind: "refused", status: 503, error: "unavailable" };
  }
  try {
    // One transaction: db.query create() inserts the row and links its role
    // in two separate commits (@strapi/database entity-manager create), and a
    // concurrent exchange reading between them would see the provider's
    // ownership fields without a role, i.e. an admin's change. The entity
    // manager's own transaction() joins this one, so both commit together.
    // The unique-violation handling below runs after the rollback.
    await strapi.db.transaction(() =>
      users.create({
        data: {
          ...admission.newRow(decision.role, email),
          email,
          confirmed: true,
          blocked: false,
          role: roleId,
        },
      }),
    );
    return { kind: "row", created: true };
  } catch (err) {
    // A concurrent first sign-in of the same person won the unique index.
    const winner = await users.findOne({ where: admission.identity, select: ["id"] });
    if (!winner) throw err;
    strapi.log.info(
      `${admission.log} concurrent first sign-in (${admission.ref}): continuing with the existing row`,
    );
    return { kind: "row", created: false };
  }
}

type RoleStep =
  | { kind: "ok"; audit: string }
  | { kind: "refused"; status: 403 | 503; error: ExchangeError; audit: string };

/**
 * Spec I for an existing user: the role decision and its write in ONE short
 * transaction, decided on a fresh read of the row, which is locked on
 * Postgres (FOR UPDATE; SQLite runs every transaction on its single
 * connection, one at a time). db.query update() commits a row's columns and
 * its relations separately, and create() inserts before it links the role:
 * a decision on a read outside the lock could see a concurrent exchange's
 * new applied role next to the old role (or none) and take that for an
 * admin's change, flipping the user to manual for good. Not optional: a
 * role the provider no longer grants must not survive a failed write, so a
 * failure here fails the sign-in (503 via the controller).
 */
async function writeRole(
  strapi: ExchangeHost,
  userId: number,
  admission: Admission,
): Promise<RoleStep> {
  return strapi.db.transaction(async () => {
    if (strapi.db.dialect.client === "postgres") {
      // The user administration's directory lock first (utils/user-admin.ts, same order):
      // a sign-in's demotion and a web demotion never both pass the last-admin check.
      await lockDocument(
        strapi as unknown as DocumentLockHost,
        USER_DIRECTORY_LOCK_UID,
        USER_DIRECTORY_LOCK_DOCUMENT_ID,
      );
      await strapi.db
        .queryBuilder(USER_UID)
        .select(["id"])
        .where({ id: userId })
        .forUpdate()
        .execute();
    }
    const users = strapi.db.query(USER_UID);
    const row = await users.findOne({
      where: { id: userId },
      select: ["id", "roleSource", "entraAppliedRole"],
      populate: { role: { select: ["id", "type"] } },
    });
    if (!row) throw new ExchangeInvariantError("user_vanished");
    const decision = admission.decide({
      roleType: isRecord(row.role) ? stringOf(row.role.type) : null,
      roleSource: stringOf(row.roleSource),
      entraAppliedRole: stringOf(row.entraAppliedRole),
    });
    if (decision.kind === "reject") {
      return {
        kind: "refused",
        status: decision.status,
        error: decision.error,
        audit: decision.audit,
      };
    }
    if (decision.kind === "update") {
      const data: Record<string, unknown> = { ...decision.data };
      if (decision.data.role !== undefined) {
        const roleId = await roleIdOf(strapi, decision.data.role);
        if (roleId === null) {
          strapi.log.error(
            `${admission.log} role ${decision.data.role} does not exist; refusing the sign-in`,
          );
          return { kind: "refused", status: 503, error: "unavailable", audit: decision.audit };
        }
        data.role = roleId;
      }
      await users.update({ where: { id: userId }, data });
    }
    return { kind: "ok", audit: decision.audit };
  });
}

async function roleIdOf(strapi: ExchangeHost, type: string): Promise<number | null> {
  const role = await strapi.db.query(ROLE_UID).findOne({ where: { type }, select: ["id"] });
  return role ? role.id : null;
}

export const DEPARTMENT_UID = "api::department.department";

const relationDocumentId = (value: unknown): string | null =>
  isRecord(value) && typeof value.documentId === "string" ? value.documentId : null;

/**
 * The department sync of a sign-in (ENTRA_SYNC_DEPARTMENT=1, or
 * OIDC_DEPARTMENT_CLAIM): the one published department whose name equals
 * `name` case-insensitively; none, several or no name clear it, so access
 * does not survive a move (entra/profile.ts pickDepartment). Returns the
 * audit value; a failure is logged, never fatal. `label` names the source
 * in the warning ("Entra", "OIDC").
 */
export async function syncDepartment(
  strapi: ExchangeHost,
  user: Row,
  name: string | null,
  mayWrite: boolean,
  log: string,
  label: string,
): Promise<string> {
  try {
    const matches =
      name === null
        ? []
        : await strapi.documents(DEPARTMENT_UID).findMany({
            filters: { name: { $eqi: name } },
            status: "published",
            fields: ["documentId"],
          });
    const target = pickDepartment(name, matches);
    if (target.kind === "clear" && target.reason !== "empty") {
      strapi.log.warn(
        `${log} user=${user.id}: the ${label} department matches ${target.reason === "no-match" ? "no" : "more than one"} published department; clearing it`,
      );
    }
    const next = target.kind === "set" ? target.documentId : null;
    const current = relationDocumentId(user.department);
    if (next === current) return "unchanged";
    const verb = next === null ? "clear" : "set";
    if (!mayWrite) return `would ${verb}`;
    const documentId = stringOf(user.documentId);
    if (documentId === null) throw new Error("the user has no documentId");
    // By documentId, like the admin panel: the link targets the document.
    // v0.28: never after a block or anonymisation (utils/unblocked-write.ts).
    const written = await writeWhileUnblocked(strapi as never, user.id as number, () =>
      strapi.documents(USER_UID).update({ documentId, data: { department: next } }),
    );
    if (!written) return "blocked";
    return verb === "set" ? "set" : "cleared";
  } catch (err) {
    strapi.log.error(`${log} user=${user.id}: department sync failed (${errorLabel(err)})`);
    return "failed";
  }
}

/**
 * The identity provider a user row is bound to: Entra (tenant + object id,
 * by the exchange or an admin binding), OIDC (issuer + subject), or none.
 */
export function idpOf(
  row: { entraTenantId?: unknown; oidcIssuer?: unknown } | null | undefined,
): "entra" | "oidc" | null {
  const set = (value: unknown) => typeof value === "string" && value.trim() !== "";
  if (set(row?.entraTenantId)) return "entra";
  if (set(row?.oidcIssuer)) return "oidc";
  return null;
}
