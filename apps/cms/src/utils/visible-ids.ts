/**
 * Server-side visibility resolution for wiki spaces, used by the
 * wiki-visibility policy. (document-visibility only needs the caller's
 * department and resolves that inline, so it does not use this helper.)
 *
 * WHY server-side ID computation instead of a REST filter that traverses
 * relations:
 *   The intranet roles are read-scoped narrowly. `guest`, for example,
 *   only holds find/findOne on document, wiki-space and wiki-page — NOT on
 *   department, team, role or wiki-revision. Strapi's core controllers run
 *   `validateQuery` → `throwRestrictedRelations` over the REQUEST filters
 *   BEFORE sanitize, so ANY REST filter that reaches through
 *   `allowedRoles` / `department` / `team` / `space` would 400 for every
 *   role lacking that relation's `.find` scope (guest, and partly member).
 *
 *   `strapi.db.query(...)` runs at the database layer: it bypasses BOTH
 *   the users-permissions gating AND `throwRestrictedRelations`. So we
 *   resolve the set of visible primary-key `id`s HERE, in the policy, by
 *   loading the (small) space set with its visibility relations populated
 *   and deciding membership in plain JS. The policy then injects only a
 *   non-relational `{ id: { $in: [...] } }` filter into the REST query —
 *   which validates for every role and traverses nothing.
 *
 * Draft & publish note (wiki spaces): `strapi.db.query` returns ALL rows
 * (draft AND published) regardless of publication state. That is
 * intentional here — the injected `id $in` list is a superset covering both
 * the draft and published rows of every visible space, and the policy pins
 * `status=published` on top. Extra ids in the list never widen what the
 * controller returns.
 *
 * Org scope is compared by numeric row id, which is valid because
 * department and team are single-row (draftAndPublish off since decision
 * 05, invariant I-ORG, pinned by content-type-flags.test.ts and the boot
 * guard utils/org-dp-guard.ts): every relation into them, from users,
 * teams and both rows of a space, links the one row, and its id never
 * changes (no publish cycle).
 *
 * Recipients (FX19): the notification fan-outs and the digest resolve every
 * active user's scope in ONE users query plus the team-lead map
 * (loadAllUserScopes) and the roles holding a read grant from
 * up_permissions at runtime (loadRoleGrants), once per run. A recipient is
 * targeted AND holds the read grant AND is not blocked.
 */
import {
  isAnnouncementVisible,
  type AnnouncementTargeting,
  type AudienceScope,
} from "./announcement-audience";

const USER_UID = "plugin::users-permissions.user";
const TEAM_UID = "api::team.team";
const PERMISSION_UID = "plugin::users-permissions.permission";

/** The read grants recipients must hold (users-permissions action keys). */
export const ANNOUNCEMENT_FIND = "api::announcement.announcement.find";
export const EVENT_FIND = "api::event.event.find";
export const KUDOS_FIND = "api::kudos.kudos.find";

/**
 * "blocked is not true", NULL-safe: SQL `blocked <> true` never matches a
 * NULL, and a user row written outside users-permissions (seed, import) can
 * carry one.
 */
export const NOT_BLOCKED = { $or: [{ blocked: false }, { blocked: { $null: true } }] };

/**
 * Row ids. department and team are single-row with stable ids (I-ORG, see
 * the header), so these compare directly against the department/team ids
 * that content links to.
 */
export interface UserScope {
  roleId?: number;
  departmentId?: number;
  /** Ids of the teams the user is a MEMBER of (`user.teams`). */
  teamIds: number[];
  /**
   * Ids of the teams the user LEADS (`team.lead`). Separate from
   * `teamIds` because the user schema has no inverse field for it and
   * because the two are not interchangeable: wiki team spaces scope by
   * membership, announcement targeting by "member OR lead".
   */
  ledTeamIds: number[];
}

interface SpaceRow {
  id: number;
  visibility: "public" | "role" | "department" | "team";
  allowedRoles?: { id: number }[];
  department?: { id: number } | null;
  team?: { id: number } | null;
}

/**
 * Load the caller's role / department / team membership from the DB.
 * `policyContext.state.user` carries the role type (used for the
 * admin/editor bypass) but not reliably the department/team relations, so
 * we resolve them explicitly — via `strapi.db.query`, which needs no
 * relation `.find` scope.
 *
 * Led teams need a second query: `team.lead` is a oneToOne relation
 * declared on the team with no inverse field on the user, so it cannot be
 * populated from the user side. The team table is small (one row per team),
 * so loading it and matching the lead in JS is cheaper
 * and less brittle than a relational `where` clause — same reasoning as
 * the id resolution above.
 *
 * Memoised per request (PL04): inside an HTTP request (`strapi.requestContext`
 * holds the Koa context) the first call per user reads the database and
 * every later call in the same request gets the same result, so a policy,
 * a controller and a lifecycle of one request share two queries. The memo
 * lives on the request context (a WeakMap entry, gone with the request),
 * never across requests: a role, department or team change applies from
 * the next request on, as before. Without a request context (cron,
 * bootstrap, tests without one) every call reads. A failed read is not
 * remembered. The result is frozen: callers only read it.
 *
 * `strapi` is the Strapi instance (a ScopeHost); it is typed `unknown` for
 * the callers that hold it untyped (the acknowledgement controller).
 */
export async function loadUserScope(instance: unknown, userId: number): Promise<UserScope> {
  const strapi = instance as ScopeHost;
  const request = currentRequest(strapi);
  if (!request) return readUserScope(strapi, userId);
  let scopes = scopesByRequest.get(request);
  if (!scopes) {
    scopes = new Map();
    scopesByRequest.set(request, scopes);
  }
  const known = scopes.get(userId);
  if (known) return known;
  const pending = readUserScope(strapi, userId);
  scopes.set(userId, pending);
  const memo = scopes;
  pending.catch(() => {
    if (memo.get(userId) === pending) memo.delete(userId);
  });
  return pending;
}

/** The slice of `strapi` loadUserScope reads; the request context is optional. */
export interface ScopeHost {
  db: {
    query(uid: string): {
      findOne(params: object): Promise<unknown>;
      findMany(params: object): Promise<unknown>;
    };
  };
  requestContext?: { get(): unknown };
}

/** Per request (the Koa context of strapi.requestContext) and user: the scope read. */
const scopesByRequest = new WeakMap<object, Map<number, Promise<UserScope>>>();

function currentRequest(strapi: ScopeHost): object | null {
  const store =
    typeof strapi.requestContext?.get === "function" ? strapi.requestContext.get() : undefined;
  return typeof store === "object" && store !== null ? store : null;
}

interface ScopeUserRow {
  role?: { id?: number } | null;
  department?: { id?: number } | null;
  teams?: { id: number }[] | null;
}

async function readUserScope(strapi: ScopeHost, userId: number): Promise<UserScope> {
  const [meFull, teams] = await Promise.all([
    strapi.db.query(USER_UID).findOne({
      where: { id: userId },
      select: ["id"],
      populate: {
        department: { select: ["id"] },
        teams: { select: ["id"] },
        role: { select: ["id"] },
      },
    }) as Promise<ScopeUserRow | null>,
    strapi.db.query(TEAM_UID).findMany({
      select: ["id"],
      populate: { lead: { select: ["id"] } },
    }),
  ]);
  return Object.freeze({
    roleId: meFull?.role?.id,
    departmentId: meFull?.department?.id,
    teamIds: Object.freeze((meFull?.teams ?? []).map((team) => team.id)) as number[],
    ledTeamIds: Object.freeze(
      rowsOf<TeamLeadRow>(teams)
        .filter((team) => team.lead?.id === userId)
        .map((team) => team.id),
    ) as number[],
  });
}

/** The slice of the Strapi instance the recipient loaders need. */
export interface ScopeStrapi {
  db: {
    query(uid: string): { findMany(params: Record<string, unknown>): Promise<unknown> };
  };
}

/** One active (not blocked) user with the scope the audience rules read. */
export interface RecipientScope extends UserScope {
  userId: number;
  /** users-permissions role type (e.g. "guest"); null without a role. */
  roleType: string | null;
}

interface UserScopeRow {
  id: number;
  role?: { id?: number; type?: string | null } | null;
  department?: { id?: number } | null;
  teams?: { id: number }[] | null;
}

interface TeamLeadRow {
  id: number;
  lead?: { id?: number } | null;
}

const rowsOf = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** team.lead has no inverse field on the user: lead id → ids of the teams they lead. */
function ledTeamMap(teams: readonly TeamLeadRow[]): Map<number, number[]> {
  const led = new Map<number, number[]>();
  for (const team of teams) {
    const leadId = team.lead?.id;
    if (leadId == null) continue;
    led.set(leadId, [...(led.get(leadId) ?? []), team.id]);
  }
  return led;
}

/**
 * Every active user's scope: ONE users query (blocked users excluded,
 * NULL-safe) plus the team-lead map — two queries whatever the user count.
 * For the fan-outs and the digest, which used to load users one by one or
 * without the blocked filter.
 */
export async function loadAllUserScopes(strapi: ScopeStrapi): Promise<RecipientScope[]> {
  const [users, teams] = await Promise.all([
    strapi.db.query(USER_UID).findMany({
      where: NOT_BLOCKED,
      select: ["id"],
      populate: {
        role: { select: ["id", "type"] },
        department: { select: ["id"] },
        teams: { select: ["id"] },
      },
    }),
    strapi.db.query(TEAM_UID).findMany({
      select: ["id"],
      populate: { lead: { select: ["id"] } },
    }),
  ]);
  const led = ledTeamMap(rowsOf<TeamLeadRow>(teams));
  return rowsOf<UserScopeRow>(users).map((user) => ({
    userId: user.id,
    roleId: user.role?.id,
    roleType: user.role?.type ?? null,
    departmentId: user.department?.id,
    teamIds: (user.teams ?? []).map((team) => team.id),
    ledTeamIds: led.get(user.id) ?? [],
  }));
}

/**
 * The announcement audience scope of a user scope (PL01): announcement
 * targeting reads a team as "member OR lead" (announcement-audience.ts),
 * unlike wiki team spaces (membership only). An anonymous caller (null)
 * stays null, which sees untargeted announcements only. The one mapping for
 * the announcement read policy, the comment/reaction targets
 * (target-visibility.ts re-exports it) and the fan-out and digest
 * recipients.
 */
export function toAudienceScope(scope: UserScope): AudienceScope;
export function toAudienceScope(scope: UserScope | null): AudienceScope | null;
export function toAudienceScope(scope: UserScope | null): AudienceScope | null {
  if (!scope) return null;
  return {
    roleId: scope.roleId,
    departmentId: scope.departmentId,
    teamIds: [...scope.teamIds, ...scope.ledTeamIds],
  };
}

/** Which roles hold which action, as up_permissions says at the time of the read. */
export interface RoleGrants {
  /** Ids of the roles holding `action`; empty when none does or it was not loaded. */
  holders(action: string): ReadonlySet<number>;
}

interface PermissionRow {
  action?: string;
  role?: { id?: number } | null;
}

/**
 * The roles that hold `actions`, read from up_permissions at runtime (one
 * query), so a grant changed in the bootstrap matrix or the admin panel
 * applies to the next fan-out or digest run without a code change here.
 */
export async function loadRoleGrants(
  strapi: ScopeStrapi,
  actions: readonly string[],
): Promise<RoleGrants> {
  const rows = await strapi.db.query(PERMISSION_UID).findMany({
    where: { action: { $in: [...actions] } },
    select: ["action"],
    populate: { role: { select: ["id"] } },
  });
  const byAction = new Map<string, Set<number>>();
  for (const row of rowsOf<PermissionRow>(rows)) {
    const roleId = row.role?.id;
    if (typeof row.action !== "string" || typeof roleId !== "number") continue;
    const roles = byAction.get(row.action) ?? new Set<number>();
    roles.add(roleId);
    byAction.set(row.action, roles);
  }
  const none: ReadonlySet<number> = new Set<number>();
  return { holders: (action) => byAction.get(action) ?? none };
}

/** Whether the user's role holds the grant (a user without a role holds nothing). */
export function holdsGrant(scope: UserScope, roles: ReadonlySet<number>): boolean {
  return scope.roleId != null && roles.has(scope.roleId);
}

/**
 * The users an announcement reaches (bell and digest): targeted
 * (isAnnouncementVisible over member-or-lead teams), holding
 * announcement.find, not blocked (`scopes` holds active users only).
 * admin_role and editor get strictly the targeted audience like everyone
 * else (owner default, FX19): their read bypass is not a subscription.
 */
export function announcementRecipients(
  announcement: AnnouncementTargeting,
  scopes: readonly RecipientScope[],
  readers: ReadonlySet<number>,
): RecipientScope[] {
  return scopes.filter(
    (scope) =>
      holdsGrant(scope, readers) && isAnnouncementVisible(announcement, toAudienceScope(scope)),
  );
}

/** Decide whether a single space is visible to the given scope. */
function isSpaceVisible(space: SpaceRow, scope: UserScope | null): boolean {
  switch (space.visibility) {
    case "public":
      return true;
    case "role":
      return (
        scope?.roleId != null &&
        (space.allowedRoles ?? []).some((r) => r.id === scope.roleId)
      );
    case "department":
      return scope?.departmentId != null && space.department?.id === scope.departmentId;
    case "team":
      return (
        scope != null &&
        space.team?.id != null &&
        scope.teamIds.includes(space.team.id)
      );
    default:
      return false;
  }
}

/**
 * Resolve the primary-key ids of every wiki-space visible to `scope`
 * (pass `null` for anonymous callers → only `public` spaces).
 *
 * Visibility rules:
 *   - public     → everyone (incl. anonymous)
 *   - role       → authenticated users whose role is in `allowedRoles`
 *   - department → authenticated users whose department is `space.department`
 *   - team       → authenticated users one of whose teams is `space.team`
 */
export async function visibleWikiSpaceIds(
  strapi: any,
  scope: UserScope | null,
): Promise<number[]> {
  const spaces: SpaceRow[] = await strapi.db.query("api::wiki-space.wiki-space").findMany({
    select: ["id", "visibility"],
    populate: {
      allowedRoles: { select: ["id"] },
      department: { select: ["id"] },
      team: { select: ["id"] },
    },
  });
  return spaces.filter((s) => isSpaceVisible(s, scope)).map((s) => s.id);
}
