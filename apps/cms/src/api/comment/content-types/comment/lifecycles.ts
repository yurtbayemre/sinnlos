import { afterCommit, inOwnTransaction } from "../../../../utils/after-commit";
import { findCommentTarget } from "../../../../utils/comment-target";
import { NOTIFICATION_UID, buildNotification } from "../../../../utils/notify";

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
    populate: { author: true },
  });
  if (!announcement?.author?.id || announcement.author.id === full.author?.id) return;

  const data = buildNotification({
    type: "comment",
    titleParts: [
      { value: full.author?.displayName, fallback: "Someone" },
      ' commented on "',
      { value: announcement.title, fallback: "an announcement" },
      '"',
    ],
    link: "/announcements",
    recipient: announcement.author.id,
    actor: full.author?.id ?? null,
  });
  await inOwnTransaction(strapi.db, () => strapi.db.query(NOTIFICATION_UID).create({ data }));
}
