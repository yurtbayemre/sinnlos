import { MODERATORS } from "../bootstrap/roles";
import { isAnnouncementVisible, type AnnouncementTargeting } from "../utils/announcement-audience";
import { visibleIdsPolicy, type VisibleIdsInput } from "../utils/policy-factories";
import { loadUserScope, toAudienceScope } from "../utils/visible-ids";

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
 * resolves the inputs. admin_role / editor bypass the filter entirely and
 * keep draft reads (they author the drafts and work in the admin panel).
 *
 * HOW IT WORKS — visibleIdsPolicy (utils/policy-factories.ts): the visible
 * primary-key ids are resolved SERVER-SIDE via `strapi.db.query` and
 * injected as a non-relational `{ id: { $in } }` clause, $and-composed
 * with the client filter, then the status is pinned to published. A REST
 * filter traversing `department` / `team` / `audienceRoles` would 400 via
 * `validateQuery` → `throwRestrictedRelations` for every role lacking that
 * relation's `.find` scope: `role.find` is granted to admin_role ONLY, so a
 * filter on `audienceRoles` would break the announcement list for literally
 * every normal employee. The ids span draft and published rows, so the
 * status pin (`?status=draft` trap, §5.24) is what keeps drafts out.
 *
 * Anonymous callers get a null scope → only untargeted announcements. (No
 * role currently reads announcements anonymously — guest has no
 * `announcement.find` — but the policy must not depend on that.)
 */

type AnnouncementRow = AnnouncementTargeting & { id: number };

const ANNOUNCEMENT_UID = "api::announcement.announcement";

async function visibleAnnouncementIds({
  strapi,
  user,
}: VisibleIdsInput<unknown>): Promise<number[]> {
  // Team targeting covers members AND the team lead — a lead is not
  // automatically listed in `team.members` (toAudienceScope).
  const scope = user ? toAudienceScope(await loadUserScope(strapi, user.id)) : null;
  const rows = (await strapi.db.query(ANNOUNCEMENT_UID).findMany({
    select: ["id", "audience"],
    populate: {
      department: { select: ["id"] },
      team: { select: ["id"] },
      audienceRoles: { select: ["id"] },
    },
  })) as AnnouncementRow[];
  return rows.filter((row) => isAnnouncementVisible(row, scope)).map((row) => row.id);
}

export default visibleIdsPolicy({
  uid: ANNOUNCEMENT_UID,
  bypass: MODERATORS,
  anonymous: "filter",
  pinPublished: true,
  loadVisibleIds: visibleAnnouncementIds,
});
