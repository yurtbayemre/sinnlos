import {
  publishedRowWhere,
  scheduleSourceFanout,
  type SourceAudience,
} from "../../../../utils/notify";
import {
  EVENT_FIND,
  holdsGrant,
  loadAllUserScopes,
  loadRoleGrants,
} from "../../../../utils/visible-ids";

/** The lifecycle result of an event row (only what the fan-out reads). */
interface EventRow {
  id?: number | string | null;
  documentId?: string | null;
  title?: string | null;
  publishedAt?: string | Date | null;
}

interface EventLifecycleEvent {
  result?: EventRow | null;
}

export default {
  async afterCreate(event: EventLifecycleEvent) {
    const { result } = event;
    if (!result?.publishedAt) return;
    await notifyForEvent(result);
  },

  // Second notify path, deliberately KEPT (issue #12) — same reasoning as in
  // announcement/lifecycles.ts: a write that flips publishedAt in place (a
  // db-layer update from a script or import) is a publish afterCreate would
  // miss, and the per-recipient dedup keeps both hooks from doubling.
  async afterUpdate(event: EventLifecycleEvent) {
    const { result } = event;
    if (!result?.publishedAt) return;
    await notifyForEvent(result);
  },
};

/**
 * The event's audience (FX19): users of its departments, or everyone for an
 * event without departments, whose role holds event.find (the calendar's
 * read grant, which guest holds) and who are not blocked; the organizer is
 * excluded. Runs after the commit (LF02) and re-reads the document's
 * current published row, like the announcement fan-out: departments,
 * organizer and title come from it. A row that cannot
 * be re-read has unknown targeting: nobody is notified (fail-closed; before
 * FX19 it notified everyone).
 */
async function loadEventAudience(ev: EventRow): Promise<SourceAudience<EventRow>> {
  const [full, scopes, grants] = await Promise.all([
    strapi.db.query("api::event.event").findOne({
      where: publishedRowWhere(ev),
      populate: { departments: { select: ["id"] }, organizer: { select: ["id"] } },
    }),
    loadAllUserScopes(strapi),
    loadRoleGrants(strapi, [EVENT_FIND]),
  ]);
  if (!full) {
    strapi.log.warn(
      `[notifications] event ${ev.id} could not be re-read, nobody notified (targeting unknown)`,
    );
    return { source: null, recipients: [], actorId: null };
  }

  const departmentIds = new Set<number>(
    (full.departments ?? []).map((department: { id: number }) => department.id),
  );
  const readers = grants.holders(EVENT_FIND);
  const organizerId: number | null = full.organizer?.id ?? null;
  const recipients = scopes
    .filter(
      (scope) =>
        holdsGrant(scope, readers) &&
        (departmentIds.size === 0 ||
          (scope.departmentId != null && departmentIds.has(scope.departmentId))),
    )
    .map((scope) => scope.userId)
    .filter((id) => id !== organizerId);
  return { source: full, recipients, actorId: organizerId };
}

/**
 * Dedup per (source document, RECIPIENT) — issue #12, same as the
 * announcement fan-out (utils/notification-source.ts): an event re-targeted
 * to another department still reaches it, and a fan-out that died half-way
 * heals on the next publish.
 */
function notifyForEvent(ev: EventRow): Promise<void> {
  // After the commit (LF02), see announcement/lifecycles.ts.
  return scheduleSourceFanout({
    strapi,
    sourceType: "event",
    row: ev,
    loadAudience: () => loadEventAudience(ev),
    titleParts: (row) => ["New event: ", { value: row.title, fallback: "Untitled" }],
    link: "/events",
  });
}
