import {
  hasAudienceBypass,
  isAnnouncementVisible,
  type AudienceScope,
  type AnnouncementTargeting,
} from "../utils/announcement-audience";
import {
  forcePublishedStatus,
  getMutableQuery,
  restrictiveIdFilter,
} from "../utils/policy-query";
import { loadUserScope } from "../utils/visible-ids";

/**
 * Enforces announcement targeting on reads of the `announcement` content
 * type. Until this policy existed, `find`/`findOne` ran with an empty
 * policy list and the `audience`/`department` filter lived ONLY in the web
 * queries — while `team` and `audienceRoles` were not applied anywhere at
 * all, so every signed-in role holding `announcement.find` read every
 * announcement (GitHub issue #9).
 *
 * Visibility rules and their edge cases live in
 * `utils/announcement-audience.ts` (pure + unit tested); this policy only
 * resolves the inputs. admin_role / editor bypass the filter entirely.
 *
 * HOW IT WORKS — id-based filtering, no relation traversal (same pattern
 * as `document-visibility.ts`, see there for the full rationale):
 *   Filters must go through `getMutableQuery` — writing to
 *   `policyContext.query` is a silent no-op (Koa prototype-getter trap).
 *   And a REST filter traversing `department` / `team` / `audienceRoles`
 *   would 400 via `validateQuery` → `throwRestrictedRelations` for every
 *   role lacking that relation's `.find` scope: `role.find` is granted to
 *   admin_role ONLY, so a filter on `audienceRoles` would break the
 *   announcement list for literally every normal employee.
 *   Instead we resolve the visible primary-key ids SERVER-SIDE via
 *   `strapi.db.query` (which bypasses permission gating and relation
 *   restrictions) and inject a single non-relational
 *   `{ id: { $in: [...] } }` clause, which validates for every role.
 *
 * The clause is `$and`-wrapped with any incoming client filter so a
 * caller-supplied filter can only narrow the result set, never widen it.
 * An empty id list must NOT become `{ id: { $in: [] } }` — sanitizeQuery
 * strips empty array operands, which would drop the filter entirely
 * (fail-open); `restrictiveIdFilter` injects `{ id: { $eq: -1 } }` instead.
 *
 * Draft & publish note: `strapi.db.query` returns both draft and published
 * rows, so the id list is a superset spanning BOTH publication states.
 * Which of them the caller gets is decided by the client-supplied `status`
 * param, so the policy pins it to "published" — otherwise `?status=draft`
 * would hand unpublished announcements to every role holding
 * `announcement.find`. See `forcePublishedStatus` for the full trap.
 * admin_role / editor keep draft access via the bypass above (they author
 * the drafts and work in the admin panel).
 */

type AnnouncementRow = AnnouncementTargeting & { id: number };

export default async (policyContext: any, _config: unknown, { strapi }: any) => {
  const user = policyContext.state?.user;

  // admin_role / editor see everything, no filter needed.
  if (hasAudienceBypass(user?.role?.type)) return true;

  // Anonymous callers get a null scope → only untargeted announcements.
  // (No role currently reads announcements anonymously — guest has no
  // `announcement.find` — but the policy must not depend on that.)
  let scope: AudienceScope | null = null;
  if (user) {
    const userScope = await loadUserScope(strapi, user.id);
    scope = {
      roleId: userScope.roleId,
      departmentId: userScope.departmentId,
      // Team targeting covers members AND the team lead — a lead is not
      // automatically listed in `team.members`.
      teamIds: [...userScope.teamIds, ...userScope.ledTeamIds],
    };
  }

  const rows: AnnouncementRow[] = await strapi.db
    .query("api::announcement.announcement")
    .findMany({
      select: ["id", "audience"],
      populate: {
        department: { select: ["id"] },
        team: { select: ["id"] },
        audienceRoles: { select: ["id"] },
      },
    });

  const idList = rows.filter((row) => isAnnouncementVisible(row, scope)).map((row) => row.id);

  const query = getMutableQuery(policyContext);
  const idFilter = restrictiveIdFilter(idList);
  query.filters = query.filters ? { $and: [query.filters, idFilter] } : idFilter;
  forcePublishedStatus(query);

  return true;
};
