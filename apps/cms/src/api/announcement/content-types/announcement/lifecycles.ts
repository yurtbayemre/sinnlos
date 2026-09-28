import { isAnnouncementVisible } from "../../../../utils/announcement-audience";
import { runSourceFanout, type SourceAudience } from "../../../../utils/notify";

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
 * Notify exactly the targeted audience — the notification carries the
 * announcement title, so a broader fan-out would leak the very thing the
 * announcement-visibility policy hides. Same rules as the policy
 * (utils/announcement-audience.ts): department AND team AND role, over
 * whatever is set. A missing row (should not happen) targets everyone,
 * which is the previous behaviour.
 */
async function loadAnnouncementAudience(
  announcement: AnnouncementRow,
): Promise<SourceAudience<AnnouncementRow>> {
  const full = await strapi.db.query("api::announcement.announcement").findOne({
    where: { id: announcement.id },
    populate: { department: true, team: true, audienceRoles: true, author: true },
  });
  const [users, teams] = await Promise.all([
    strapi.db.query("plugin::users-permissions.user").findMany({
      populate: {
        department: { select: ["id"] },
        teams: { select: ["id"] },
        role: { select: ["id"] },
      },
    }),
    strapi.db.query("api::team.team").findMany({
      select: ["id"],
      populate: { lead: { select: ["id"] } },
    }),
  ]);
  // team.lead has no inverse field on the user, so build the reverse map.
  const ledTeamIds = new Map<number, number[]>();
  for (const team of teams ?? []) {
    const leadId = team.lead?.id;
    if (leadId == null) continue;
    ledTeamIds.set(leadId, [...(ledTeamIds.get(leadId) ?? []), team.id]);
  }
  const authorId: number | null = full?.author?.id ?? null;
  const recipients = (users ?? [])
    .filter((user: { id: number; role?: { id: number }; department?: { id: number }; teams?: { id: number }[] }) =>
      isAnnouncementVisible(full ?? {}, {
        roleId: user.role?.id,
        departmentId: user.department?.id,
        teamIds: [
          ...(user.teams ?? []).map((team) => team.id),
          ...(ledTeamIds.get(user.id) ?? []),
        ],
      }),
    )
    .map((user: { id: number }) => user.id)
    .filter((id: number) => id !== authorId);
  return { source: full ?? null, recipients, actorId: authorId };
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
