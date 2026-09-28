import { MODERATORS, hasRole } from "../bootstrap/roles";
import { loadPollViewer, POLL_UID, type PollCaller } from "../utils/poll-access";
import { canSeePoll, type PollTargeting } from "../utils/poll-audience";
import {
  forcePublishedStatus,
  getMutableQuery,
  narrowFilters,
  restrictiveIdFilter,
} from "../utils/policy-query";

/**
 * Enforces poll department targeting and guest access on reads of the
 * `poll` content type (find and findOne; decision 02, owner decision
 * 2026-09-27 for guests). The rules live in `utils/poll-audience.ts`
 * (`canSeePoll`): a company-wide poll is visible to every signed-in role, a
 * targeted one only to members of its departments, and a guest sees either
 * only when the poll is `visibleToGuests`; admin_role / editor bypass. The
 * vote and results controllers apply the same rules to the custom routes.
 *
 * It REPLACES `global::published-only` on these routes (it pins the status
 * itself); do not stack both.
 *
 *   1. No signed-in user: false (403). No role reads polls anonymously.
 *   2. admin_role / editor: true with the query untouched, so they keep
 *      draft reads for authoring (?status=draft).
 *   3. Everyone else: the ids of the PUBLISHED poll rows the caller may see
 *      (audience, and for a guest `visibleToGuests`) are resolved
 *      server-side and injected as a plain `id` filter, then the status is
 *      pinned to published.
 *
 * HOW IT WORKS — the same id-injection pattern as quick-link-visibility
 * and announcement-visibility:
 *   - getMutableQuery trap: filters written onto `policyContext.query` are a
 *     silent no-op (Koa prototype getter); only
 *     `policyContext.request.query` reaches the controller.
 *   - No relation filter: a REST filter through `departments` would 400
 *     for guest (no `department.find`, validateQuery →
 *     throwRestrictedRelations). The ids come from `strapi.db.query`
 *     instead, and the injected clause is `$and`-wrapped with any client
 *     filter, so a client can only narrow the result. findOne honours the
 *     injected filters too (document service findOne merges them with the
 *     documentId).
 *   - Empty-list trap: an empty id list must not become `{ id: { $in: [] } }`
 *     (sanitizeQuery strips the empty operand and the query fails OPEN);
 *     `restrictiveIdFilter` injects `{ id: { $eq: -1 } }`.
 *   - ?status=draft trap: only published rows are evaluated (the audience
 *     of a draft is not live), and `forcePublishedStatus` pins the status
 *     so a client cannot switch to the draft rows (and drops the
 *     publication-cohort keys).
 *
 * Returns a strict boolean (Strapi treats undefined as PASS).
 */

interface PollVisibilityContext {
  state?: { user?: PollCaller | null };
  request?: { query?: Record<string, unknown> };
  query?: Record<string, unknown>;
}

/** Everything the policy reads from Strapi (a superset of PollAccessHost). */
export interface PollVisibilityHost {
  db: {
    query(uid: string): {
      findOne(params: Record<string, unknown>): Promise<unknown>;
      findMany(params: Record<string, unknown>): Promise<unknown[]>;
    };
  };
}

type PollRow = PollTargeting & { id: number };

const isPollRow = (row: unknown): row is PollRow =>
  typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "number";

export default async (
  policyContext: PollVisibilityContext,
  _config: unknown,
  { strapi }: { strapi: PollVisibilityHost },
): Promise<boolean> => {
  const user = policyContext.state?.user;
  if (!user) return false;

  // admin_role / editor see every poll; drafts too (they author them).
  if (hasRole(user, MODERATORS)) return true;

  const viewer = await loadPollViewer(strapi, user);
  const rows = await strapi.db.query(POLL_UID).findMany({
    where: { publishedAt: { $notNull: true } },
    select: ["id", "audience", "visibleToGuests"],
    populate: { departments: { select: ["documentId"] } },
  });
  const idList = rows
    .filter(isPollRow)
    .filter((row) => canSeePoll(row, viewer))
    .map((row) => row.id);

  const query = getMutableQuery(policyContext);
  narrowFilters(query, restrictiveIdFilter(idList));
  forcePublishedStatus(query);

  return true;
};
