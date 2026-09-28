import { runSourceFanout, type SourceAudience } from "../../../../utils/notify";

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
 * Users of the event's departments, or everyone for an event without
 * departments; the organizer is excluded. A missing row (should not happen)
 * notifies everyone, the previous behaviour.
 */
async function loadEventAudience(ev: EventRow): Promise<SourceAudience<EventRow>> {
  const full = await strapi.db.query("api::event.event").findOne({
    where: { id: ev.id },
    populate: { departments: true, organizer: true },
  });

  let users: Array<{ id: number }>;
  if (full?.departments?.length) {
    const deptIds = full.departments.map((d: { id: number }) => d.id);
    users = await strapi.db.query("plugin::users-permissions.user").findMany({
      where: { department: { id: { $in: deptIds } } },
    });
  } else {
    users = await strapi.db.query("plugin::users-permissions.user").findMany({});
  }

  const organizerId: number | null = full?.organizer?.id ?? null;
  const recipients = (users ?? []).map((user) => user.id).filter((id) => id !== organizerId);
  return { source: full ?? null, recipients, actorId: organizerId };
}

/**
 * Dedup per (source document, RECIPIENT) — issue #12, same as the
 * announcement fan-out (utils/notification-source.ts): an event re-targeted
 * to another department still reaches it, and a fan-out that died half-way
 * heals on the next publish.
 */
function notifyForEvent(ev: EventRow): Promise<void> {
  return runSourceFanout({
    strapi,
    sourceType: "event",
    row: ev,
    loadAudience: () => loadEventAudience(ev),
    titleParts: (row) => ["New event: ", { value: row.title, fallback: "Untitled" }],
    link: "/events",
  });
}
