import { hasAudienceBypass } from "../utils/announcement-audience";
import { getMutableQuery, restrictiveIdFilter } from "../utils/policy-query";
import { visibleTargetAnchors } from "../utils/target-visibility";

/**
 * Enforces TARGET visibility on reads of `comment` and `reaction`
 * (GitHub issue #28). Both types anchor on `targetType` +
 * `targetDocumentId`; until this policy existed their find/findOne ran
 * with empty policy arrays, so any signed-in role holding `.find`
 * (including guest) could read the full discussion under an
 * audience-restricted announcement or a restricted wiki page — provided
 * it knew the documentId. documentIds are treated as unguessable
 * capability tokens (§5.17), which was the ONLY protection.
 *
 * HOW IT WORKS — same shape as `announcement-visibility.ts` /
 * `wiki-visibility.ts` (see there for the Koa-query and 400-trap
 * rationale): the visible anchors are resolved server-side via
 * `strapi.db.query` and injected as a NON-relational filter on the two
 * plain string columns, `$and`-composed with any client filter so it can
 * only narrow, never widen. No relation traversal → validates for every
 * role (guest holds no department/team/role `.find`).
 *
 * Empty-list trap: `$in: []` operands are stripped by sanitizeQuery
 * (fail-open!), so a branch is only emitted when its list is non-empty;
 * with no visible target at all the tested `restrictiveIdFilter` scalar
 * (`{ id: { $eq: -1 } }` — `id` is a plain attribute here too) makes the
 * query match nothing.
 *
 * No `forcePublishedStatus`: comment/reaction have draftAndPublish
 * disabled. Cost note: one announcements scan + one spaces scan per read,
 * the same O as the sibling visibility policies — fine at intranet scale.
 */
export default async (policyContext: any, _config: unknown, { strapi }: any) => {
  const user = policyContext.state?.user;

  // admin_role / editor moderate everything, no filter needed.
  if (hasAudienceBypass(user?.role?.type)) return true;

  const anchors = await visibleTargetAnchors(strapi, user ?? null);

  const branches: Record<string, unknown>[] = [];
  if (anchors.announcement.length > 0) {
    branches.push({
      targetType: "announcement",
      targetDocumentId: { $in: anchors.announcement },
    });
  }
  if (anchors["wiki-page"].length > 0) {
    branches.push({
      targetType: "wiki-page",
      targetDocumentId: { $in: anchors["wiki-page"] },
    });
  }

  const visibilityFilter =
    branches.length === 0
      ? restrictiveIdFilter([])
      : branches.length === 1
        ? branches[0]
        : { $or: branches };

  const query = getMutableQuery(policyContext);
  query.filters = query.filters ? { $and: [query.filters, visibilityFilter] } : visibilityFilter;

  return true;
};
