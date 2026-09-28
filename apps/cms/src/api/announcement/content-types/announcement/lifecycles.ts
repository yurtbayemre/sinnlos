import { runSourceFanout, type SourceAudience } from "../../../../utils/notify";
import {
  ANNOUNCEMENT_FIND,
  announcementRecipients,
  loadAllUserScopes,
  loadRoleGrants,
} from "../../../../utils/visible-ids";

/** The lifecycle result of an announcement row (only what the fan-out reads). */
interface AnnouncementRow {
  id?: number | string | null;
  documentId?: string | null;
  title?: string | null;
  publishedAt?: string | Date | null;
}

interface AnnouncementEvent {
  result?: AnnouncementRow | null;
}

export default {
  async afterCreate(event: AnnouncementEvent) {
    const { result } = event;
    if (!result?.publishedAt) return;
    await notifyForAnnouncement(result);
  },

  // Second notify path, deliberately KEPT (issue #12).
  //
  // announcement is draftAndPublish and the documents-service publish path is
  // delete-then-recreate, so a (re-)publish surfaces as afterCreate with
  // publishedAt set, while a normal save keeps the draft (publishedAt null)
  // and returns below — this hook almost never notifies. "Almost never" is
  // not "never" though: a write that flips publishedAt in place (db-layer
  // update from a script/import, or a future core change to the publish
  // implementation) is a publish that afterCreate would MISS entirely.
  //
  // The fan-out is deduped per (source document, recipient) (resolveFanout,
  // §5.26), so whichever hook runs first writes the anchored notifications
  // and the other one finds them and has nobody left to notify.
  async afterUpdate(event: AnnouncementEvent) {
    const { result } = event;
    if (!result?.publishedAt) return;
    await notifyForAnnouncement(result);
  },
};

/**
 * Notify exactly the audience that can read the announcement (FX19):
 * targeted (department AND team AND role over whatever is set, the rules of
 * the announcement-visibility policy, utils/announcement-audience.ts), with
 * a role that holds announcement.find (read from up_permissions at runtime,
 * so guest is out), and not blocked. The notification carries the title, so
 * a broader fan-out would leak what the policy hides. admin_role and editor
 * get strictly the targeted audience (owner default). The author is not
 * notified.
 *
 * A row that cannot be re-read has unknown targeting: nobody is notified
 * (fail-closed; before FX19 it targeted everyone).
 */
async function loadAnnouncementAudience(
  announcement: AnnouncementRow,
): Promise<SourceAudience<AnnouncementRow>> {
  const [full, scopes, grants] = await Promise.all([
    strapi.db.query("api::announcement.announcement").findOne({
      where: { id: announcement.id },
      populate: {
        department: { select: ["id"] },
        team: { select: ["id"] },
        audienceRoles: { select: ["id"] },
        author: { select: ["id"] },
      },
    }),
    loadAllUserScopes(strapi),
    loadRoleGrants(strapi, [ANNOUNCEMENT_FIND]),
  ]);
  if (!full) {
    strapi.log.warn(
      `[notifications] announcement ${announcement.id} could not be re-read, nobody notified (targeting unknown)`,
    );
    return { source: null, recipients: [], actorId: null };
  }
  const authorId: number | null = full.author?.id ?? null;
  const recipients = announcementRecipients(full, scopes, grants.holders(ANNOUNCEMENT_FIND))
    .map((scope) => scope.userId)
    .filter((id) => id !== authorId);
  return { source: full, recipients, actorId: authorId };
}

/**
 * Dedup per (source document, RECIPIENT) — issue #12, see
 * utils/notification-source.ts: a re-publish (delete+recreate, new row id,
 * same documentId) notifies only the audience members without an anchored
 * row yet, so a retargeted announcement still reaches its new audience and
 * a fan-out that died half-way heals on the next publish. Legacy rows
 * without an anchor cannot match: the FIRST re-publish of an old
 * announcement notifies its audience once more (accepted instead of a
 * title-based backfill, §7b / issue #12).
 */
function notifyForAnnouncement(announcement: AnnouncementRow): Promise<void> {
  return runSourceFanout({
    strapi,
    sourceType: "announcement",
    row: announcement,
    loadAudience: () => loadAnnouncementAudience(announcement),
    titleParts: (row) => ["New announcement: ", { value: row.title, fallback: "Untitled" }],
    link: "/announcements",
  });
}
