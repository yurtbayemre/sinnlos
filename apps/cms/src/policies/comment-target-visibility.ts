import { MODERATORS, hasRole } from "../bootstrap/roles";
import { isCommentTargetType } from "../utils/comment-target";
import { identifiedCaller, type PolicyContext, type PolicyStrapi } from "../utils/policy-factories";
import {
  canNarrow,
  getMutableQuery,
  narrowFilters,
  narrowReads,
  oneParamIn,
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
 * The full path (#175, v0.33): each anchor list goes to the Document
 * Service as ONE bound parameter (`text[]` on Postgres, a JSON array on
 * SQLite: oneParamIn), ANDed into the comment or reaction reads of this
 * request (narrowReads), list and count alike; no bind limit to fail at.
 * The root type comes from the route's handler; any other route, or a
 * request without a request context to carry the clause, is refused.
 *
 * Empty-list trap: `$in: []` operands are stripped by sanitizeQuery
 * (fail-open!), so a branch is only emitted when its list is non-empty;
 * with no visible target at all the tested `restrictiveIdFilter` scalar
 * (`{ id: { $eq: -1 } }` — `id` is a plain attribute here too) makes the
 * query match nothing.
 *
 * Unpublished announcements (owner answer 2026-09-29 (b)): a thread whose
 * announcement has no published row is read like the thread of a
 * documentId that never existed: nothing, on the fast and the full path
 * alike (utils/target-visibility.ts), and it comes back with the next
 * publish. Wiki pages keep their draft fallback.
 *
 * admin_role / editor moderate everything (bypass, query untouched; they
 * also read the rows of a missing target this way). A caller without a
 * numeric id is treated as anonymous. No `forcePublishedStatus`:
 * comment/reaction have draftAndPublish disabled.
 */
export default async (
  policyContext: PolicyContext,
  _config: unknown,
  { strapi }: { strapi: PolicyStrapi },
): Promise<boolean> => {
  const user = policyContext.state?.user;
  if (hasRole(user, MODERATORS)) return true;
  const root = rootUid(policyContext);
  if (!root || !canNarrow(strapi, policyContext.state)) return false;
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
  const branches: Record<string, unknown>[] = [];
  for (const targetType of ["announcement", "wiki-page"] as const) {
    if (anchors[targetType].length === 0) continue;
    branches.push({
      targetType,
      targetDocumentId: { $in: oneParamIn(strapi, anchors[targetType], "text") },
    });
  }
  if (branches.length === 0) {
    narrowFilters(query, restrictiveIdFilter([]));
    return true;
  }
  return narrowReads(
    strapi,
    policyContext.state,
    root,
    branches.length === 1 ? branches[0] : { $or: branches },
  );
};

/** The types this policy guards, by the route's handler (`api::comment.comment.find`). */
const ROOT_UIDS = new Set(["api::comment.comment", "api::reaction.reaction"]);

function rootUid(policyContext: PolicyContext): string | null {
  const handler = (policyContext.state as { route?: { handler?: unknown } } | undefined)?.route
    ?.handler;
  if (typeof handler !== "string") return null;
  const uid = handler.slice(0, handler.lastIndexOf("."));
  return ROOT_UIDS.has(uid) ? uid : null;
}
