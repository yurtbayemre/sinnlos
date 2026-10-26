/**
 * GET /api/me/open-acks (v0.31, #172): how many mandatory announcements and
 * documents the caller has not confirmed yet, for the dashboard banner. It
 * used to walk every mandatory item and every own receipt page by page from
 * the web, and each page ran the visibility policy again.
 *
 * The rule is the one the content API applies to the banner's former reads
 * (computeOpenAcks over GET /api/announcements and /api/documents with
 * `requiresAck`), resolved by the same functions:
 *   - a kind counts only while the caller's role holds its `find` and
 *     `acknowledgement.find` (the grants as up_permissions says now);
 *     otherwise it is null, "not available", never 0 (guest has neither);
 *   - admin_role and editor read every row (the policies' bypass, expired
 *     announcements included); everyone else the row ids of
 *     visibleAnnouncementIds or departmentScopedIds, bound as one
 *     parameter like the policies' (oneParamIn, #175);
 *   - only published rows with `requiresAck`, as the policies' status pin;
 *   - minus the caller's own receipts of that type, by documentId.
 * The route is gated by `read-confirmations` (utils/module-switches.ts).
 */
import { MODERATORS, hasRole } from "../bootstrap/roles";
import {
  departmentScopedIds,
  identifiedCaller,
  type IdentifiedCaller,
  type PolicyCaller,
  type PolicyStrapi,
  type VisibleIdsInput,
} from "./policy-factories";
import { oneParamIn } from "./policy-query";
import {
  ANNOUNCEMENT_FIND,
  holdsGrant,
  loadRoleGrants,
  loadUserScope,
  visibleAnnouncementIds,
} from "./visible-ids";

const ACK_UID = "api::acknowledgement.acknowledgement";
const ACK_FIND = `${ACK_UID}.find`;
const DOCUMENT_UID = "api::document.document";
const DOCUMENT_FIND = `${DOCUMENT_UID}.find`;

const KINDS = {
  announcement: {
    uid: "api::announcement.announcement",
    find: ANNOUNCEMENT_FIND,
    loadVisibleIds: visibleAnnouncementIds,
  },
  document: { uid: DOCUMENT_UID, find: DOCUMENT_FIND, loadVisibleIds: departmentScopedIds },
} as const;

type Kind = keyof typeof KINDS;

/** The banner's numbers; null: the caller may not read that kind. */
export interface OpenAckCounts {
  announcements: number | null;
  documents: number | null;
}

const documentIdsOf = (rows: unknown, field: string): string[] =>
  (Array.isArray(rows) ? rows : [])
    .map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>)[field] : null))
    .filter((value): value is string => typeof value === "string" && value !== "");

/** The open count of one kind for a caller who may read it. */
async function openOf(strapi: PolicyStrapi, kind: Kind, user: IdentifiedCaller): Promise<number> {
  const { uid, loadVisibleIds } = KINDS[kind];
  const where: Record<string, unknown>[] = [
    { publishedAt: { $notNull: true } },
    { requiresAck: true },
  ];
  if (!hasRole(user, MODERATORS)) {
    const input: VisibleIdsInput<unknown> = { strapi, user, config: undefined, uid };
    // The visible ids as ONE bound parameter (#175): no bind limit.
    where.push({ id: { $in: oneParamIn(strapi, await loadVisibleIds(input), "int") } });
  }
  const [rows, receipts] = await Promise.all([
    strapi.db.query(uid).findMany({ where: { $and: where }, select: ["documentId"] }),
    strapi.db.query(ACK_UID).findMany({
      where: { user: { id: user.id }, targetType: kind },
      select: ["targetDocumentId"],
    }),
  ]);
  const acked = new Set(documentIdsOf(receipts, "targetDocumentId"));
  return new Set(documentIdsOf(rows, "documentId").filter((id) => !acked.has(id))).size;
}

/** GET /api/me/open-acks for `user` (the authenticated caller). */
export async function openAckCounts(
  strapi: PolicyStrapi,
  user: PolicyCaller | null | undefined,
): Promise<OpenAckCounts> {
  const caller = identifiedCaller(user);
  if (!caller) return { announcements: null, documents: null };
  const [scope, grants] = await Promise.all([
    loadUserScope(strapi, caller.id),
    loadRoleGrants(strapi, [ACK_FIND, ANNOUNCEMENT_FIND, DOCUMENT_FIND]),
  ]);
  const mayRead = (kind: Kind) =>
    holdsGrant(scope, grants.holders(ACK_FIND)) &&
    holdsGrant(scope, grants.holders(KINDS[kind].find));
  const count = (kind: Kind) => (mayRead(kind) ? openOf(strapi, kind, caller) : null);
  const [announcements, documents] = await Promise.all([count("announcement"), count("document")]);
  return { announcements, documents };
}
