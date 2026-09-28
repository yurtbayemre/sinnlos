import { MODERATORS, hasRole } from "../bootstrap/roles";
import { isCommentTargetType } from "../utils/comment-target";
import { identifiedCaller, type PolicyContext, type PolicyStrapi } from "../utils/policy-factories";
import {
  fitsBindLimit,
  getMutableQuery,
  narrowFilters,
  restrictiveIdFilter,
} from "../utils/policy-query";
import {
  isTargetVisible,
  pinnedTargetAnchor,
  visibleTargetAnchors,
} from "../utils/target-visibility";

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
 * HOW IT WORKS — same shape as the id-based visibility policies (see
 * utils/policy-factories.ts for the Koa-query and 400-trap rationale): the
 * visible anchors are resolved server-side via `strapi.db.query` and
 * injected as a NON-relational filter on the two plain string columns,
 * `$and`-composed with any client filter so it can only narrow, never
 * widen. No relation traversal → validates for every role (guest holds no
 * department/team/role `.find`).
 *
 * Single-anchor fast path (PL04): the web reads one thread at a time with
 * `filters[targetType][$eq]=…&filters[targetDocumentId][$eq]=…`. When the
 * client filter pins exactly one anchor like that (pinnedTargetAnchor,
 * utils/target-visibility.ts), only that target is checked (isTargetVisible,
 * the rule the create controllers use) instead of resolving every visible
 * announcement and wiki page. A visible anchor gets the same branch the
 * full path would inject for it, `{ targetType, targetDocumentId: { $in:
 * [anchor] } }`; an invisible one `restrictiveIdFilter([])`. Since the
 * client filter already restricts the rows to that anchor, both paths
 * return the same rows; any other filter shape takes the full path.
 *
 * Bind limit (PL04): more anchors than one statement may bind (Postgres
 * 65535, SQLite 32766 parameters, utils/policy-query.ts) answer with
 * nothing and an error log instead of an SQL error.
 *
 * Empty-list trap: `$in: []` operands are stripped by sanitizeQuery
 * (fail-open!), so a branch is only emitted when its list is non-empty;
 * with no visible target at all the tested `restrictiveIdFilter` scalar
 * (`{ id: { $eq: -1 } }` — `id` is a plain attribute here too) makes the
 * query match nothing.
 *
 * admin_role / editor moderate everything (bypass, query untouched). A
 * caller without a numeric id is treated as anonymous. No
 * `forcePublishedStatus`: comment/reaction have draftAndPublish disabled.
 */
export default async (
  policyContext: PolicyContext,
  _config: unknown,
  { strapi }: { strapi: PolicyStrapi },
): Promise<boolean> => {
  const user = policyContext.state?.user;
  if (hasRole(user, MODERATORS)) return true;
  const caller = identifiedCaller(user);
  const query = getMutableQuery(policyContext);

  const pin = pinnedTargetAnchor(query.filters);
  if (pin) {
    const visible =
      isCommentTargetType(pin.targetType) &&
      (await isTargetVisible(strapi, pin.targetType, pin.targetDocumentId, caller));
    narrowFilters(
      query,
      visible
        ? { targetType: pin.targetType, targetDocumentId: { $in: [pin.targetDocumentId] } }
        : restrictiveIdFilter([]),
    );
    return true;
  }

  const anchors = await visibleTargetAnchors(strapi, caller);
  // Both anchor lists are bound into the one statement (PL04): fail closed.
  const bound = anchors.announcement.length + anchors["wiki-page"].length;
  if (!fitsBindLimit(strapi, bound, "comment-target-visibility anchors")) {
    narrowFilters(query, restrictiveIdFilter([]));
    return true;
  }

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

  narrowFilters(query, visibilityFilter);
  return true;
};
