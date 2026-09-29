import { errors } from "@strapi/utils";
import { hasRole, isRoleType, type RoleType } from "../bootstrap/roles";
import { isRowId, parseEntryRef } from "./entry-id";
import {
  boundedIdFilter,
  forcePublishedStatus,
  getMutableQuery,
  narrowFilters,
} from "./policy-query";

/**
 * Policy factories (PL02) and the lookup primitive they share with the
 * id-addressed controllers (PL01).
 *
 * Every read or ownership policy used to hand-roll the same steps, and each
 * step is a Strapi trap when it is done slightly wrong (docs/architecture.md
 * §5.14, §5.15, §5.24). The factories do them once, in this order:
 *
 *   1. no signed-in user: false where the policy is not meant for
 *      anonymous callers;
 *   2. the bypass roles pass with the request untouched and no data read
 *      (hasRole, exact role types);
 *   3. a caller without a numeric row id owns nothing and is nobody in
 *      particular: false for ownership, the anonymous scope for a
 *      visibility filter (an undefined id in a where clause would match
 *      an arbitrary row);
 *   4. the clause goes onto the REAL request query (getMutableQuery),
 *      $and-composed with the client filter (narrowFilters), an empty id
 *      list as restrictiveIdFilter's `{ id: { $eq: -1 } }` (an empty `$in`
 *      is stripped by sanitizeQuery and fails open), and a list beyond the
 *      database's bind-parameter limit the same way, with an error log
 *      (boundedIdFilter: fail closed instead of an SQL error);
 *   5. draft & publish types get status=published AFTER the bypass
 *      (forcePublishedStatus);
 *   6. every branch returns a strict boolean: Strapi counts `undefined` as
 *      a pass. The one other outcome is an ownerGate built with
 *      `refusal: "forbidden"`, which throws its refusals as
 *      ForbiddenError("Forbidden") (is-comment-author, PL03).
 *
 * Strapi resolves `global::<name>` by file name, so every policy keeps its
 * own small file in src/policies that calls a factory with its rules
 * (bypass roles, owner field, loader). The per-policy bypass sets are part
 * of those rules and differ on purpose: personal data (acknowledgements,
 * notifications, lesson progress, RSVPs) bypasses admin_role only, content
 * visibility and moderation bypass admin_role and editor, and
 * is-classified-author takes its bypass from the route config.
 */

/** The slice of `strapi` a lookup reads (a db.query; the dialect for the bind limit). */
export interface PolicyDb {
  db: {
    query(uid: string): {
      findOne(params: object): Promise<unknown>;
      findMany(params: object): Promise<unknown>;
    };
    dialect?: { client?: unknown };
  };
}

/** What the factories read from `strapi`: the db, and the log when there is one. */
export interface PolicyStrapi extends PolicyDb {
  log?: { error(message: string): void };
}

/** The caller as users-permissions puts it on ctx.state.user. */
export interface PolicyCaller {
  id?: unknown;
  role?: { type?: unknown } | null;
}

/** A caller with a usable row id: the only kind that can own rows. */
export interface IdentifiedCaller extends PolicyCaller {
  id: number;
}

/** The slice of the Strapi policy context the factories read and write. */
export interface PolicyContext {
  state?: { user?: PolicyCaller | null };
  params?: { id?: unknown };
  request?: { query?: Record<string, unknown> };
}

/** A Strapi policy: (policyContext, route config, { strapi }) → strict boolean. */
export type Policy<Config = unknown> = (
  policyContext: PolicyContext,
  config: Config,
  deps: { strapi: PolicyStrapi },
) => Promise<boolean>;

/** A row as the query engine returns it: always an id and a documentId. */
export interface EntryRow {
  id: number;
  documentId: string;
  [field: string]: unknown;
}

export interface FindByRefOptions {
  /** Columns to read besides id and documentId (default: all, like findOne). */
  select?: readonly string[];
  /** Relations to populate, as the query engine takes them. */
  populate?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isEntryRow = (row: unknown): row is EntryRow =>
  isRecord(row) && typeof row.id === "number" && typeof row.documentId === "string";

/** The caller with a usable row id, or null (anonymous, or no numeric id). */
export function identifiedCaller(user: PolicyCaller | null | undefined): IdentifiedCaller | null {
  return user && isRowId(user.id) ? (user as IdentifiedCaller) : null;
}

/** The numeric ids of query-engine rows (rows without one are skipped). */
export function rowIds(rows: unknown): number[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row: unknown) => (isRecord(row) ? row.id : undefined))
    .filter((id): id is number => typeof id === "number");
}

/**
 * The row an id from the request names, or null (PL01).
 *
 * `idParam` is a route `:id` (or any id a client sent): a row id or a
 * documentId, checked by parseEntryRef BEFORE any query, so a malformed
 * value never reaches Postgres (utils/entry-id.ts: an int4 `id` lookup with
 * "abc" or "2147483648" was a 500). null means "no such entry" for every
 * reason alike (missing, malformed, out of range, not found), so the
 * caller answers them the same way: 404 in a controller, false in a policy.
 *
 * The id-addressed core routes resolve documentIds only; a controller that
 * accepts a numeric id translates it with the row's documentId before it
 * calls super (the v5 core delete answered 204 and deleted nothing for a
 * numeric id):
 *
 *   const entity = await findByRef(strapi, UID, ctx.params.id);
 *   if (!entity) return ctx.notFound();
 *   ctx.params.id = entity.documentId;
 *
 * Reads through strapi.db.query: no permission gating, draft and published
 * rows alike (the types behind these routes have no draft & publish).
 */
export async function findByRef<T extends EntryRow = EntryRow>(
  strapi: PolicyDb,
  uid: string,
  idParam: unknown,
  options: FindByRefOptions = {},
): Promise<T | null> {
  const where = parseEntryRef(idParam);
  if (!where) return null;
  const row = await strapi.db.query(uid).findOne({
    where,
    ...(options.select ? { select: [...new Set(["id", "documentId", ...options.select])] } : {}),
    ...(options.populate ? { populate: options.populate } : {}),
  });
  return isEntryRow(row) ? (row as T) : null;
}

// ---------------------------------------------------------------------------
// ownRowsFilter: personal rows (acknowledgements, notifications, ...)
// ---------------------------------------------------------------------------

export interface OwnRowsOptions {
  /** The relation to the owning user (`user`, `recipient`). */
  ownerField: string;
  /** Roles that read every row, with the request untouched. */
  bypass: readonly RoleType[];
  /**
   * Runs for a non-bypass caller before the clause is added, with the real
   * request query; throw a ValidationError to refuse the request (400).
   */
  checkQuery?: (query: Record<string, unknown>) => void;
}

/** An own-rows policy reads no data, so it needs neither config nor `strapi`. */
export type OwnRowsPolicy = (
  policyContext: PolicyContext,
  config?: unknown,
  deps?: unknown,
) => Promise<boolean>;

/**
 * A read policy that narrows a list or findOne to the caller's own rows:
 * `{ [ownerField]: { id: caller } }`, $and-composed with the client filter.
 * No signed-in user, or one without a numeric id: false. The owner clause
 * references the users-permissions relation, so every role reading through
 * it also needs `users-permissions.user.find` (validateQuery,
 * throwRestrictedRelations); every role holds it (§5.8).
 * No status pin: these types have no draft & publish.
 */
export function ownRowsFilter(options: OwnRowsOptions): OwnRowsPolicy {
  return async (policyContext) => {
    const user = policyContext.state?.user;
    if (!user) return false;
    if (hasRole(user, options.bypass)) return true;

    const caller = identifiedCaller(user);
    if (!caller) return false;

    const query = getMutableQuery(policyContext);
    options.checkQuery?.(query);
    narrowFilters(query, { [options.ownerField]: { id: caller.id } });
    return true;
  };
}

// ---------------------------------------------------------------------------
// visibleIdsPolicy: rows resolved server-side, injected as an id filter
// ---------------------------------------------------------------------------

export interface VisibleIdsInput<Config> {
  strapi: PolicyStrapi;
  /** The caller, or null for an anonymous request or a caller without an id. */
  user: IdentifiedCaller | null;
  /** The route's policy config. */
  config: Config;
  /** The content type the route reads. */
  uid: string;
}

export interface VisibleIdsOptions<Config> {
  /** The content type the route reads (per config, e.g. the wiki level). */
  uid: string | ((config: Config) => string);
  /** Roles that read every row, drafts included, with the request untouched. */
  bypass: readonly RoleType[];
  /**
   * The row ids the caller may read, from strapi.db.query (no permission
   * gating, no relation restrictions, draft and published rows alike).
   */
  loadVisibleIds(input: VisibleIdsInput<Config>): Promise<readonly number[]>;
  /** Pin status=published after the bypass: every draft & publish type. */
  pinPublished: boolean;
  /**
   * A request without a signed-in user: "filter" resolves the ids for the
   * anonymous scope, "deny" refuses it (false). "deny" also refuses a
   * caller without a numeric id.
   */
  anonymous: "filter" | "deny";
}

/**
 * A read policy for a type whose visibility needs relations the caller may
 * not filter by (validateQuery 400s a relation filter for every role without
 * that relation's `.find`, e.g. guest on department): the loader decides in
 * JS which row ids are visible, and the policy injects the non-relational
 * `{ id: { $in } }` (§5.14-§5.16, §5.24). findOne honours it too (the
 * document service merges the filters with the documentId).
 */
export function visibleIdsPolicy<Config = unknown>(
  options: VisibleIdsOptions<Config>,
): Policy<Config> {
  return async (policyContext, config, { strapi }) => {
    const user = policyContext.state?.user ?? null;
    if (!user && options.anonymous === "deny") return false;
    if (hasRole(user, options.bypass)) return true;

    const caller = identifiedCaller(user);
    if (!caller && options.anonymous === "deny") return false;

    const uid = typeof options.uid === "function" ? options.uid(config) : options.uid;
    const ids = await options.loadVisibleIds({ strapi, user: caller, config, uid });

    const query = getMutableQuery(policyContext);
    narrowFilters(query, boundedIdFilter(strapi, ids, `${uid} read policy`));
    if (options.pinPublished) forcePublishedStatus(query);
    return true;
  };
}

/** The `audience` value that keeps a department-scoped row restricted (FX29 residual). */
export const DEPARTMENTS_AUDIENCE = "departments";

/**
 * Loader for types scoped by a `departments` (manyToMany) relation
 * (document, quick-link): a row without departments is company-wide, every
 * caller sees it, anonymous included; a row with departments only the
 * members of one of them. The caller's department is read from the
 * database (ctx.state.user does not carry it reliably). department is
 * single-row since decision 05, so row ids compare directly (I-ORG).
 *
 * "Flag OR links", the poll pattern (FX29 residual, owner answer
 * 2026-09-29 (b)): a row is targeted when it links a department OR its
 * `audience` flag says 'departments'. Deleting a department cascades its
 * link rows away, so a row targeted only by that department would turn
 * company-wide; every row that links a department carries the flag
 * already (the write-time guard utils/department-audience-guard.ts and its
 * boot backfill), and the department delete hook sets it once more
 * (utils/department-delete-restrict.ts). A flagged row without departments
 * is visible to no one here, i.e. to admin_role and editor only (the
 * policy's bypass), until a moderator re-targets it (links departments, or
 * sets the audience back to 'all'). NULL (rows from before the flag) and
 * 'all' leave the decision to the links, as before.
 */
export async function departmentScopedIds({
  strapi,
  user,
  uid,
}: VisibleIdsInput<unknown>): Promise<number[]> {
  let departmentId: number | undefined;
  if (user) {
    const me = await strapi.db.query("plugin::users-permissions.user").findOne({
      where: { id: user.id },
      select: ["id"],
      populate: { department: { select: ["id"] } },
    });
    const department = isRecord(me) ? me.department : null;
    const id = isRecord(department) ? department.id : undefined;
    departmentId = typeof id === "number" ? id : undefined;
  }

  const rows = await strapi.db.query(uid).findMany({
    select: ["id", "audience"],
    populate: { departments: { select: ["id"] } },
  });
  const visible: number[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRecord(row) || typeof row.id !== "number") continue;
    const departments: unknown[] = Array.isArray(row.departments) ? row.departments : [];
    const companyWide = departments.length === 0 && row.audience !== DEPARTMENTS_AUDIENCE;
    const ownDepartment =
      departmentId != null &&
      departments.some((department) => isRecord(department) && department.id === departmentId);
    // Company-wide: everyone, anonymous included. Scoped: only the members
    // of a linked department (never anonymous, who has no department).
    // Flagged without departments: nobody but the bypass roles.
    if (companyWide || ownDepartment) visible.push(row.id);
  }
  return visible;
}

// ---------------------------------------------------------------------------
// ownerGate: write/delete only by the row's owner
// ---------------------------------------------------------------------------

/** A route config that may name its own bypass roles (is-classified-author). */
export interface BypassRolesConfig {
  bypassRoles?: unknown;
}

export interface OwnerGateOptions {
  /** The content type the route writes. */
  uid: string;
  /** The relation to the owning user (`author`, `user`, `recipient`). */
  ownerField: string;
  /** Roles that pass without a lookup. */
  bypass: readonly RoleType[];
  /**
   * Take the bypass from the route's `config.bypassRoles` when it is set:
   * its role types, and nobody for a value that is not a list. `bypass`
   * applies without one.
   */
  bypassFromConfig?: boolean;
  /**
   * A `:id` that names no row (malformed, out of range, missing, unknown):
   *   - "refuse" (the default): refused like a foreign row, so the answer
   *     never tells the two apart;
   *   - "handler": passed on to the route handler, which answers it itself
   *     (the comment delete's 404, PL03). There is no row to protect, and
   *     the handler must look the id up again anyway (findByRef) to
   *     translate it. A caller without a numeric id is still refused.
   */
  unknownRow?: "refuse" | "handler";
  /**
   * How a refusal reaches the client:
   *   - "policy" (the default): the gate returns false and Strapi answers
   *     its PolicyError (403, message "Policy Failed");
   *   - "forbidden": the gate throws ForbiddenError("Forbidden"), which
   *     Strapi's error middleware turns into exactly the body of
   *     `ctx.forbidden()`. For a route whose controller used to refuse by
   *     itself, so moving the check into a policy changes no byte of the
   *     answer (PL03).
   */
  refusal?: "policy" | "forbidden";
}

/** The ctx.forbidden() answer, thrown from a policy (OwnerGateOptions.refusal). */
export const FORBIDDEN_MESSAGE = "Forbidden";

/** The bypass roles a route config names (see OwnerGateOptions.bypassFromConfig). */
export function configuredBypass(
  config: BypassRolesConfig | null | undefined,
  fallback: readonly RoleType[],
): readonly RoleType[] {
  const roles = config?.bypassRoles;
  if (roles == null) return fallback;
  return Array.isArray(roles) ? roles.filter(isRoleType) : [];
}

/**
 * A write/delete gate: only the owner of the row the route `:id` names
 * passes (plus the bypass roles). The `:id` is a row id or a documentId
 * (findByRef); a malformed, missing or unknown one is false like a foreign
 * row, so the answer never tells them apart. A caller without a numeric id
 * owns nothing, not even a row whose owner is gone (a deleted user leaves
 * the relation null).
 *
 * Passing the policy does not translate the id for the core route: the
 * controllers that accept a numeric id do that with findByRef themselves.
 *
 * `unknownRow` and `refusal` adapt the answers for a route whose
 * controller used to check ownership itself (see OwnerGateOptions); the
 * defaults are the rules above.
 */
export function ownerGate(options: OwnerGateOptions): Policy<BypassRolesConfig | undefined> {
  const refuse = (): false => {
    if (options.refusal === "forbidden") throw new errors.ForbiddenError(FORBIDDEN_MESSAGE);
    return false;
  };
  return async (policyContext, config, { strapi }) => {
    const user = policyContext.state?.user;
    if (!user) return refuse();
    const bypass = options.bypassFromConfig
      ? configuredBypass(config, options.bypass)
      : options.bypass;
    if (hasRole(user, bypass)) return true;

    const caller = identifiedCaller(user);
    if (!caller) return refuse();

    const row = await findByRef(strapi, options.uid, policyContext.params?.id, {
      populate: { [options.ownerField]: { select: ["id"] } },
    });
    if (!row) return options.unknownRow === "handler" ? true : refuse();
    const owner = row[options.ownerField];
    return isRecord(owner) && owner.id === caller.id ? true : refuse();
  };
}
