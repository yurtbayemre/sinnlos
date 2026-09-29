/**
 * Target visibility for comments and reactions (GitHub issue #28).
 *
 * Comments/reactions anchor on `targetType` + `targetDocumentId` and until
 * #28 their reads/creates never checked whether the caller may see the
 * TARGET — the only protection was that documentIds are unguessable
 * capability tokens (docs/architecture.md §5.17). This module decides
 * "may this user see this target?" by reusing the existing single sources
 * of truth: `announcement-audience.ts` for announcements and the
 * wiki-space rules from `visible-ids.ts` for wiki pages.
 *
 * Consumers:
 *   - the `comment-target-visibility` read policy: the SET of visible
 *     anchors for a list (to inject a non-relational filter), or, when the
 *     client filter pins exactly one anchor (pinnedTargetAnchor, PL04),
 *     the single-target check for that anchor only;
 *   - the comment/reaction create controllers: the single-target check.
 *
 * ONE rule for both, so a list and a single-anchor read can never
 * disagree: a target is judged by the row `findCommentTarget` would
 * resolve, its PUBLISHED row when it has one, else its draft. For an
 * announcement that row's targeting decides; for a wiki page that row's
 * space (a page's draft and published rows link the draft and published
 * rows of their spaces, whose visibility can differ until a publish).
 *
 * Fail-closed rules: unknown targetType → invisible; wiki page without a
 * space → invisible; missing rows → invisible.
 *
 * Expiry (DA02, owner answer 2026-09-29 (b)): an announcement whose
 * `expiresAt` instant has passed is invisible like one outside the
 * caller's audience (utils/announcement-expiry.ts), so its thread leaves
 * with it: the list and single reads, comment and reaction creates. The
 * admin_role / editor bypass keeps it, as the announcement read policy
 * does.
 */

import { MODERATORS, hasRole, type RoleHolder } from "../bootstrap/roles";
import { isAnnouncementVisible } from "./announcement-audience";
import { isAnnouncementExpired } from "./announcement-expiry";
import { targetAnchor, type CommentTargetType } from "./comment-target";
import type { PolicyStrapi } from "./policy-factories";
import { fitsBindLimit } from "./policy-query";
import { loadUserScope, toAudienceScope, visibleWikiSpaceIds } from "./visible-ids";

/** A signed-in caller with a row id (the scope is loaded by it). */
export interface CallerUser extends RoleHolder {
  id: number;
}

/**
 * Announcement targeting covers members AND leads (unlike wiki spaces); one
 * mapping for every announcement audience check (visible-ids.ts).
 */
export { toAudienceScope };

const ANNOUNCEMENT_UID = "api::announcement.announcement";
const WIKI_PAGE_UID = "api::wiki-page.wiki-page";

type AnnouncementRow = {
  documentId?: string | null;
  publishedAt?: string | null;
  expiresAt?: string | null;
  department?: { id: number } | null;
  team?: { id: number } | null;
  audienceRoles?: { id: number }[] | null;
};

const ANNOUNCEMENT_POPULATE = {
  department: { select: ["id"] },
  team: { select: ["id"] },
  audienceRoles: { select: ["id"] },
};

const listOf = <T>(rows: unknown): T[] => (Array.isArray(rows) ? (rows as T[]) : []);

/**
 * Pick the row whose targeting counts per documentId: published first,
 * draft as fallback — exactly `findCommentTarget`'s resolution order.
 */
function preferPublished(rows: AnnouncementRow[]): Map<string, AnnouncementRow> {
  const byAnchor = new Map<string, AnnouncementRow>();
  for (const row of rows) {
    const anchor = targetAnchor(row.documentId);
    if (anchor == null) continue;
    const current = byAnchor.get(anchor);
    if (!current || (!current.publishedAt && row.publishedAt)) byAnchor.set(anchor, row);
  }
  return byAnchor;
}

export interface VisibleTargetAnchors {
  announcement: string[];
  "wiki-page": string[];
}

/**
 * The anchors of the wiki pages visible through the spaces `spaceIds`
 * (row ids of every visible space row, draft or published), by the rule
 * isTargetVisible applies to one page: the published row decides when
 * there is one, else the draft.
 *
 *   1. The rows of pages in a visible space (draft and published alike): a
 *      page with its PUBLISHED row among them is visible.
 *   2. A page with only its draft among them is visible unless it has a
 *      published row elsewhere (in a space the caller cannot see): one
 *      lookup for those documentIds.
 *
 * Neither query populates anything, so the only bind parameters are the
 * two id lists; either beyond the bind limit fails closed (PL04): no pages
 * for the first, none of the draft-only pages for the second.
 */
async function visibleWikiPageAnchors(strapi: PolicyStrapi, spaceIds: number[]): Promise<string[]> {
  if (spaceIds.length === 0) return [];
  if (!fitsBindLimit(strapi, spaceIds.length, "comment targets: wiki spaces")) return [];
  const rows = listOf<{ documentId?: string | null; publishedAt?: string | null }>(
    await strapi.db.query(WIKI_PAGE_UID).findMany({
      where: { space: { id: { $in: spaceIds } } },
      select: ["documentId", "publishedAt"],
    }),
  );
  const published = new Set<string>();
  for (const row of rows) {
    if (row.publishedAt && typeof row.documentId === "string") published.add(row.documentId);
  }
  const draftOnly = new Set<string>();
  for (const row of rows) {
    if (typeof row.documentId === "string" && !published.has(row.documentId)) {
      draftOnly.add(row.documentId);
    }
  }
  if (draftOnly.size > 0 && !fitsBindLimit(strapi, draftOnly.size, "comment targets: drafts")) {
    draftOnly.clear();
  }
  if (draftOnly.size > 0) {
    const elsewhere = listOf<{ documentId?: string | null }>(
      await strapi.db.query(WIKI_PAGE_UID).findMany({
        where: { documentId: { $in: [...draftOnly] }, publishedAt: { $notNull: true } },
        select: ["documentId"],
      }),
    );
    for (const row of elsewhere) {
      if (typeof row.documentId === "string") draftOnly.delete(row.documentId);
    }
  }
  return [
    ...new Set(
      [...published, ...draftOnly]
        .map((documentId) => targetAnchor(documentId))
        .filter((anchor): anchor is string => anchor != null),
    ),
  ];
}

/**
 * All target anchors (documentIds) visible to `user` (`null` = anonymous).
 * The admin/editor bypass is the CALLER's job (the policy returns early) —
 * this function always evaluates the restrictive rules.
 */
export async function visibleTargetAnchors(
  strapi: PolicyStrapi,
  user: CallerUser | null | undefined,
): Promise<VisibleTargetAnchors> {
  const raw = user ? await loadUserScope(strapi, user.id) : null;
  const audience = toAudienceScope(raw);

  const [announcementRows, spaceIds] = await Promise.all([
    strapi.db.query(ANNOUNCEMENT_UID).findMany({
      select: ["id", "documentId", "publishedAt", "audience", "expiresAt"],
      populate: ANNOUNCEMENT_POPULATE,
    }),
    visibleWikiSpaceIds(strapi, raw),
  ]);

  const now = new Date();
  const announcement = [...preferPublished(listOf<AnnouncementRow>(announcementRows)).entries()]
    .filter(([, row]) => !isAnnouncementExpired(row, now) && isAnnouncementVisible(row, audience))
    .map(([anchor]) => anchor);

  return { announcement, "wiki-page": await visibleWikiPageAnchors(strapi, spaceIds) };
}

/**
 * May `user` see this single target? The create controllers map `false` to
 * the exact same 400 as a nonexistent target
 * (`WRITE_TARGET_ERRORS["unresolved-target"]`), so create stays free of
 * existence oracles (§5.17); the read policy uses it for a single-anchor
 * filter (PL04).
 */
export async function isTargetVisible(
  strapi: PolicyStrapi,
  targetType: CommentTargetType,
  targetDocumentId: string,
  user: CallerUser | null | undefined,
): Promise<boolean> {
  if (hasRole(user, MODERATORS)) return true;
  const raw = user ? await loadUserScope(strapi, user.id) : null;

  if (targetType === "announcement") {
    const rows = listOf<AnnouncementRow>(
      await strapi.db.query(ANNOUNCEMENT_UID).findMany({
        where: { documentId: targetDocumentId },
        select: ["id", "documentId", "publishedAt", "audience", "expiresAt"],
        populate: ANNOUNCEMENT_POPULATE,
      }),
    );
    const row = preferPublished(rows).get(targetDocumentId);
    if (!row || isAnnouncementExpired(row, new Date())) return false;
    return isAnnouncementVisible(row, toAudienceScope(raw));
  }

  if (targetType === "wiki-page") {
    type PageRow = { space?: { id?: number } | null } | null;
    const page = (await strapi.db.query(WIKI_PAGE_UID).findOne({
      where: { documentId: targetDocumentId, publishedAt: { $notNull: true } },
      populate: { space: { select: ["id"] } },
    })) as PageRow;
    const anyPage =
      page ??
      ((await strapi.db.query(WIKI_PAGE_UID).findOne({
        where: { documentId: targetDocumentId },
        populate: { space: { select: ["id"] } },
      })) as PageRow);
    // A page without a space has no visibility owner — fail closed.
    const spaceId = anyPage?.space?.id;
    if (spaceId == null) return false;
    const spaceIds = await visibleWikiSpaceIds(strapi, raw);
    return spaceIds.includes(spaceId);
  }

  return false;
}

// ---------------------------------------------------------------------------
// The single-anchor fast path of the read policy (PL04)
// ---------------------------------------------------------------------------

/** One {targetType, targetDocumentId} pair a client filter pins. */
export interface PinnedTargetAnchor {
  targetType: string;
  targetDocumentId: string;
}

const PIN_KEYS = ["targetType", "targetDocumentId"] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

/** `{ $eq: "<string>" }` and nothing else, or null. */
function eqString(value: unknown): string | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "$eq") return null;
  return typeof value.$eq === "string" ? value.$eq : null;
}

/**
 * The anchor a client filter pins, when it pins EXACTLY one (PL04), else
 * null (the caller takes the full path).
 *
 * Accepted: `targetType` and `targetDocumentId`, each as `{ $eq: string }`,
 * at the top level of the filter object or at the top level of an object
 * inside a top-level `$and` array. That is the web's comment-section
 * filter (`filters[targetType][$eq]=…&filters[targetDocumentId][$eq]=…`,
 * apps/web/src/lib/comment-target.ts). Every other key there (`$or`,
 * `$not`, `body`, …) is another conjunct: it can only narrow the rows, so
 * the result stays inside the pinned anchor.
 *
 * Anything else is "not pinned": a missing key, a second, different value
 * for the same key, any other operator or shape for the two keys (`$in`,
 * `$eqi`, `$ne`, a bare string, an array), an `$and` that is no array or
 * holds a non-object, and a pin nested deeper than one `$and` level.
 */
export function pinnedTargetAnchor(filters: unknown): PinnedTargetAnchor | null {
  if (!isPlainObject(filters)) return null;
  const conjuncts: Record<string, unknown>[] = [filters];
  if (hasOwn(filters, "$and")) {
    const and = filters.$and;
    if (!Array.isArray(and)) return null;
    for (const item of and) {
      if (!isPlainObject(item)) return null;
      conjuncts.push(item);
    }
  }
  const values: Record<(typeof PIN_KEYS)[number], Set<string>> = {
    targetType: new Set(),
    targetDocumentId: new Set(),
  };
  for (const conjunct of conjuncts) {
    for (const key of PIN_KEYS) {
      if (!hasOwn(conjunct, key)) continue;
      const value = eqString(conjunct[key]);
      if (value === null) return null;
      values[key].add(value);
    }
  }
  if (values.targetType.size !== 1 || values.targetDocumentId.size !== 1) return null;
  const [targetType] = values.targetType;
  const [targetDocumentId] = values.targetDocumentId;
  return { targetType, targetDocumentId };
}
