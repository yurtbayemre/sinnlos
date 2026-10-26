import { MODERATORS } from "../bootstrap/roles";
import { loadPollViewer, POLL_UID } from "../utils/poll-access";
import { canSeePoll, type PollTargeting } from "../utils/poll-audience";
import { findAllPaged } from "../utils/paged-read";
import { visibleIdsPolicy, type VisibleIdsInput } from "../utils/policy-factories";

/**
 * Enforces poll department targeting and guest access on reads of the
 * `poll` content type (find and findOne; decision 02, owner decision
 * 2026-09-27 for guests). The rules live in `utils/poll-audience.ts`
 * (`canSeePoll`): a company-wide poll is visible to every signed-in role, a
 * targeted one only to members of its departments, and a guest sees either
 * only when the poll is `visibleToGuests`; admin_role / editor bypass. The
 * vote and results controllers apply the same rules to the custom routes;
 * voting itself is never bypassed (canVoteOnPoll), this is the READ bypass
 * only.
 *
 * It REPLACES `global::published-only` on these routes (it pins the status
 * itself); do not stack both.
 *
 *   1. No signed-in user (or one without a numeric id): false (403). No
 *      role reads polls anonymously.
 *   2. admin_role / editor: true with the query untouched, so they keep
 *      draft reads for authoring (?status=draft).
 *   3. Everyone else: the ids of the PUBLISHED poll rows the caller may see
 *      (audience, and for a guest `visibleToGuests`) are resolved
 *      server-side and injected as a plain `id` filter, then the status is
 *      pinned to published.
 *
 * HOW IT WORKS — visibleIdsPolicy (utils/policy-factories.ts), the same
 * id-injection pattern as quick-link-visibility and announcement-visibility:
 * no relation filter (a REST filter through `departments` would 400 for
 * guest, validateQuery → throwRestrictedRelations), the id clause ANDed
 * into the reads by the Document Service (the list as one parameter, #175;
 * an empty list matches nothing), and `forcePublishedStatus` so a client
 * cannot switch to the draft rows (only published rows are evaluated: the
 * audience of a draft is not live). findOne honours the clause too (the
 * document service merges the filters with the documentId).
 */

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

async function visiblePollIds({ strapi, user }: VisibleIdsInput<unknown>): Promise<number[]> {
  // "deny": the factory never calls this without an identified caller.
  if (!user) return [];
  const roleType = user.role?.type;
  const viewer = await loadPollViewer(strapi, {
    id: user.id,
    role: { type: typeof roleType === "string" ? roleType : null },
  });
  // Paged (utils/paged-read.ts, #175): the populate binds one page of ids.
  const rows = await findAllPaged<PollRow>(strapi.db.query(POLL_UID), {
    where: { publishedAt: { $notNull: true } },
    select: ["id", "audience", "visibleToGuests"],
    populate: { departments: { select: ["documentId"] } },
  });
  return rows
    .filter(isPollRow)
    .filter((row) => canSeePoll(row, viewer))
    .map((row) => row.id);
}

export default visibleIdsPolicy({
  uid: POLL_UID,
  bypass: MODERATORS,
  anonymous: "deny",
  pinPublished: true,
  loadVisibleIds: visiblePollIds,
});
