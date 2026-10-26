import { MODERATORS, hasRole } from "../../../../bootstrap/roles";
import { afterCommit, inOwnTransaction } from "../../../../utils/after-commit";
import { isAnnouncementExpired } from "../../../../utils/announcement-expiry";
import { findCommentTarget } from "../../../../utils/comment-target";
import { NOTIFICATION_UID, buildNotification } from "../../../../utils/notify";
import {
  ANNOUNCEMENT_FIND,
  announcementRecipients,
  loadRoleGrants,
  loadUserScope,
  withFreshAnnouncementFlags,
} from "../../../../utils/visible-ids";

interface CommentEvent {
  result?: { id?: number | string | null } | null;
}

export default {
  // After the comment's transaction commits (LF02), like the announcement
  // fan-out. Inside it, a failing notification INSERT aborted the
  // transaction on Postgres despite the catch: COMMIT then rolled the
  // comment back without an error, the API still answered 201, and the
  // comment was lost. Now the notification is written in a transaction of
  // its own, and a failure costs the notification only.
  async afterCreate(event: CommentEvent) {
    const id = event.result?.id;
    if (id == null) return;
    await afterCommit(
      strapi.db,
      () => notifyAnnouncementAuthor(id),
      (err) => strapi.log.error(`[notifications] failed for comment: ${(err as Error)?.message}`),
    );
  },
};

/**
 * Re-reads the comment after the commit: a comment that is not there (a
 * rollback the commit callbacks did not hear about, utils/after-commit.ts)
 * notifies nobody.
 */
async function notifyAnnouncementAuthor(commentId: number | string): Promise<void> {
  const full = await strapi.db.query("api::comment.comment").findOne({
    where: { id: commentId },
    populate: { author: true },
  });
  if (!full) return;

  // Only announcement comments notify anybody: wiki pages have no
  // author-notification feature yet (the wiki-page branch of targetType
  // exists in the schema and is handled by findCommentTarget, it just has
  // no recipient to fan out to here). A reply notifies the announcement's
  // author as well, never the parent comment's author.
  if (full.targetType !== "announcement") return;

  // Resolve via the documentId anchor, NOT the numeric row id: the
  // published row id changes on every re-publish (delete+recreate), so
  // an id lookup either found nothing or — after id recycling — the
  // wrong announcement, and the author of a foreign entry got the
  // notification (issue #11).
  const announcement = await findCommentTarget(strapi, full, {
    populate: {
      author: { populate: { role: { select: ["type"] } } },
      department: { select: ["id"] },
      team: { select: ["id"] },
      audienceRoles: { select: ["id"] },
    },
  });
  if (!announcement?.author?.id || announcement.author.id === full.author?.id) return;
  // A blocked author left (v0.28): nothing new reaches them.
  if (announcement.author.blocked === true) return;
  if (!(await authorCanRead(announcement))) return;

  const data = buildNotification({
    type: "comment",
    titleParams: { actor: full.author?.displayName, subject: announcement.title },
    link: "/announcements",
    recipient: announcement.author.id,
    actor: full.author?.id ?? null,
  });
  await inOwnTransaction(strapi.db, () => strapi.db.query(NOTIFICATION_UID).create({ data }));
}

/**
 * Whether the announcement's author can still read it (v0.30). The
 * notification names the current title, and a moderator may have
 * retargeted the announcement away from its author since it was written.
 * The read policy's rule (policies/announcement-visibility.ts): admin_role
 * and editor read every announcement; anyone else needs a published row
 * that has not ended, targets them, and the announcement.find grant,
 * checked with the fan-out's own predicate for this one user
 * (utils/visible-ids.ts).
 */
async function authorCanRead(announcement: any): Promise<boolean> {
  const author = announcement.author;
  const roleType: string | null = author.role?.type ?? null;
  if (hasRole(author, MODERATORS)) return true;
  if (!announcement.publishedAt || isAnnouncementExpired(announcement, new Date())) return false;
  const [scope, grants, checked] = await Promise.all([
    loadUserScope(strapi, author.id),
    loadRoleGrants(strapi, [ANNOUNCEMENT_FIND]),
    // The flags again after the relations (utils/targeting-flags.ts).
    withFreshAnnouncementFlags(strapi, [announcement], { id: announcement.id }),
  ]);
  const reader = { ...scope, userId: author.id, roleType };
  return announcementRecipients(checked[0], [reader], grants.holders(ANNOUNCEMENT_FIND)).length > 0;
}
