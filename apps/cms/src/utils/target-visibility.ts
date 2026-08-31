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
 * Two consumers:
 *   - the `comment-target-visibility` read policy needs the SET of visible
 *     anchors (to inject a non-relational filter),
 *   - the comment/reaction create controllers need a single-target check.
 *
 * Fail-closed rules: unknown targetType → invisible; wiki page without a
 * space → invisible; missing rows → invisible. Announcement targeting is
 * evaluated on the row `findCommentTarget` would resolve (published first,
 * draft as fallback) so read/write visibility and anchor resolution can
 * never disagree.
 */

import {
  hasAudienceBypass,
  isAnnouncementVisible,
  type AudienceScope,
} from "./announcement-audience";
import { loadUserScope, visibleWikiSpaceIds, type UserScope } from "./visible-ids";
import { targetAnchor, type CommentTargetType } from "./comment-target";

interface CallerUser {
  id: number;
  role?: { type?: string } | null;
}

/** Announcement targeting covers members AND leads (unlike wiki spaces). */
function toAudienceScope(raw: UserScope | null): AudienceScope | null {
  if (!raw) return null;
  return {
    roleId: raw.roleId,
    departmentId: raw.departmentId,
    teamIds: [...raw.teamIds, ...raw.ledTeamIds],
  };
}

type AnnouncementRow = {
  documentId?: string | null;
  publishedAt?: string | null;
  department?: { id: number } | null;
  team?: { id: number } | null;
  audienceRoles?: { id: number }[] | null;
};

const ANNOUNCEMENT_POPULATE = {
  department: { select: ["id"] },
  team: { select: ["id"] },
  audienceRoles: { select: ["id"] },
};

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
 * All target anchors (documentIds) visible to `user` (`null` = anonymous).
 * The admin/editor bypass is the CALLER's job (the policy returns early) —
 * this function always evaluates the restrictive rules.
 */
export async function visibleTargetAnchors(
  strapi: any,
  user: CallerUser | null | undefined,
): Promise<VisibleTargetAnchors> {
  const raw = user ? await loadUserScope(strapi, user.id) : null;
  const audience = toAudienceScope(raw);

  const [announcementRows, spaceIds] = await Promise.all([
    strapi.db.query("api::announcement.announcement").findMany({
      select: ["id", "documentId", "publishedAt", "audience"],
      populate: ANNOUNCEMENT_POPULATE,
    }) as Promise<AnnouncementRow[]>,
    visibleWikiSpaceIds(strapi, raw),
  ]);

  const announcement = [...preferPublished(announcementRows).entries()]
    .filter(([, row]) => isAnnouncementVisible(row, audience))
    .map(([anchor]) => anchor);

  let wikiPage: string[] = [];
  if (spaceIds.length > 0) {
    const pages: { documentId?: string | null }[] = await strapi.db
      .query("api::wiki-page.wiki-page")
      .findMany({
        where: { space: { id: { $in: spaceIds } } },
        select: ["documentId"],
      });
    wikiPage = [
      ...new Set(
        pages
          .map((p) => targetAnchor(p.documentId))
          .filter((anchor): anchor is string => anchor != null),
      ),
    ];
  }

  return { announcement, "wiki-page": wikiPage };
}

/**
 * May `user` see this single target? Used on the WRITE path — the caller
 * maps `false` to the exact same 400 as a nonexistent target
 * (`WRITE_TARGET_ERRORS["unresolved-target"]`), so create stays free of
 * existence oracles (§5.17).
 */
export async function isTargetVisible(
  strapi: any,
  targetType: CommentTargetType,
  targetDocumentId: string,
  user: CallerUser | null | undefined,
): Promise<boolean> {
  if (hasAudienceBypass(user?.role?.type)) return true;
  const raw = user ? await loadUserScope(strapi, user.id) : null;

  if (targetType === "announcement") {
    const rows: AnnouncementRow[] = await strapi.db
      .query("api::announcement.announcement")
      .findMany({
        where: { documentId: targetDocumentId },
        select: ["id", "documentId", "publishedAt", "audience"],
        populate: ANNOUNCEMENT_POPULATE,
      });
    const row = preferPublished(rows).get(targetDocumentId);
    if (!row) return false;
    return isAnnouncementVisible(row, toAudienceScope(raw));
  }

  if (targetType === "wiki-page") {
    const page = await strapi.db.query("api::wiki-page.wiki-page").findOne({
      where: { documentId: targetDocumentId, publishedAt: { $notNull: true } },
      populate: { space: { select: ["id"] } },
    });
    const anyPage =
      page ??
      (await strapi.db.query("api::wiki-page.wiki-page").findOne({
        where: { documentId: targetDocumentId },
        populate: { space: { select: ["id"] } },
      }));
    // A page without a space has no visibility owner — fail closed.
    const spaceId = anyPage?.space?.id;
    if (spaceId == null) return false;
    const spaceIds = await visibleWikiSpaceIds(strapi, raw);
    return spaceIds.includes(spaceId);
  }

  return false;
}
