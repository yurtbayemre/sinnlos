import { factories } from "@strapi/strapi";

/**
 * Event RSVPs follow the acknowledgement pattern (server-authoritative
 * user, published-target check, documentId anchoring) with ONE deliberate
 * difference: they are MUTABLE. `create` is an upsert per
 * (user, targetDocumentId) so users can change their answer (yes ⇄ maybe
 * ⇄ no) through a single endpoint.
 *
 * Target anchoring — documentId, NOT the numeric id:
 *   event is draftAndPublish, and Strapi 5 re-publishes by DELETING and
 *   RE-CREATING the published row (new numeric id every time). An RSVP
 *   anchored to the numeric id would silently detach on the next
 *   "Publish" click, so RSVPs reference `targetDocumentId` (string),
 *   which is stable across the whole draft/publish lifecycle.
 */

const RSVP_UID = "api::event-rsvp.event-rsvp";
const EVENT_UID = "api::event.event";

const STATUSES = ["yes", "no", "maybe"] as const;
type RsvpStatus = (typeof STATUSES)[number];

function isRsvpStatus(value: unknown): value is RsvpStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

/**
 * Read privacy for find/findOne: attendance ("yes") is public inside the
 * intranet, but WHO declined or is unsure is not. Strip the user relation
 * from every row that is neither status=yes nor the caller's own answer
 * (admin_role sees everything) — maybe/no stay countable, the names of
 * decliners don't leak. The web summaries keep working: they need `user`
 * only for the yes-names list and the caller's own status.
 */
function stripPrivateUsers(rows: any[], caller: any): void {
  if (caller?.role?.type === "admin_role") return;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (row.status === "yes") continue;
    if (caller && row.user?.id === caller.id) continue;
    delete row.user;
  }
}

/**
 * Count how many DISTINCT users currently answer "yes" for the event,
 * excluding `excludeUserId` (the caller — their own switch to "yes" must
 * not count against themselves). Distinct users, not rows: the accepted
 * check-then-insert race (below) can leave duplicate rows per user until
 * the next upsert heals them, and counting rows would then overstate the
 * occupancy.
 */
async function countYesUsers(
  strapi: any,
  targetDocumentId: string,
  excludeUserId: number,
): Promise<number> {
  const rows = await strapi.db.query(RSVP_UID).findMany({
    where: { targetDocumentId, status: "yes" },
    populate: { user: true },
  });
  const userIds = new Set<number>();
  for (const row of rows) {
    const id = row.user?.id;
    if (id != null && id !== excludeUserId) userIds.add(id);
  }
  return userIds.size;
}

/**
 * Capacity gate for a transition INTO "yes". Returns true when the event
 * is full for this caller.
 *
 * NOTE — accepted check-then-insert race (poll-vote / acknowledgement
 * pattern): two concurrent "yes" answers can both pass this check and
 * overshoot the capacity by one. A DB-level constraint would be the
 * airtight fix, but the count spans a relation via a link table, so there
 * is no single-table constraint to declare without fighting Strapi's
 * schema management. For an intranet sign-up list an off-by-one in a
 * photo-finish is acceptable; the UI always renders the authoritative
 * server counts after refresh.
 */
async function isAtCapacity(strapi: any, event: any, userId: number): Promise<boolean> {
  const capacity = event.capacity;
  if (!Number.isInteger(capacity) || capacity <= 0) return false;
  const yesUsers = await countYesUsers(strapi, event.documentId, userId);
  return yesUsers >= capacity;
}

export default factories.createCoreController(RSVP_UID, ({ strapi }) => ({
  /** Core find, post-filtered: see stripPrivateUsers above. */
  async find(ctx) {
    const response = await super.find(ctx);
    if (Array.isArray(response?.data)) {
      stripPrivateUsers(response.data, ctx.state.user);
    }
    return response;
  },

  /** Core findOne, post-filtered the same way as find. */
  async findOne(ctx) {
    const response = await super.findOne(ctx);
    if (response?.data) {
      stripPrivateUsers([response.data], ctx.state.user);
    }
    return response;
  },

  /**
   * Upsert: POST /api/event-rsvps with { data: { targetDocumentId, status } }.
   * Creates the caller's RSVP or updates the existing one — users may
   * change their answer any number of times.
   */
  async create(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const body = (ctx.request.body ?? {}) as any;
    const data = body.data ?? body;
    const targetDocumentId = data?.targetDocumentId;
    const status = data?.status;

    if (typeof targetDocumentId !== "string" || targetDocumentId.length === 0) {
      return ctx.badRequest("targetDocumentId required");
    }
    if (!isRsvpStatus(status)) return ctx.badRequest("Invalid status");

    const event = await strapi.db.query(EVENT_UID).findOne({
      where: { documentId: targetDocumentId, publishedAt: { $notNull: true } },
    });
    // Deliberately ONE identical error (message + status) for both failure
    // modes — "does not exist / draft only" and "rsvpEnabled=false" — so
    // the endpoint is no existence oracle for draft documentIds.
    if (!event || !event.rsvpEnabled) {
      return ctx.badRequest("Event not available for RSVP");
    }

    // findMany, not findOne: the accepted check-then-insert race (below)
    // can leave more than one row per (user, targetDocumentId). Heal on
    // the next upsert — keep the newest row (respondedAt, then id) and
    // delete the surplus before updating.
    const existingRows = await strapi.db.query(RSVP_UID).findMany({
      where: { user: user.id, targetDocumentId },
    });
    existingRows.sort((a: any, b: any) => {
      const aTime = a.respondedAt ? new Date(a.respondedAt).getTime() : 0;
      const bTime = b.respondedAt ? new Date(b.respondedAt).getTime() : 0;
      return bTime - aTime || b.id - a.id;
    });
    const existing = existingRows[0] ?? null;
    for (const stale of existingRows.slice(1)) {
      await strapi.db.query(RSVP_UID).delete({ where: { id: stale.id } });
    }

    // Capacity only gates transitions INTO "yes"; an existing "yes" may
    // always be re-confirmed or withdrawn.
    if (status === "yes" && existing?.status !== "yes") {
      if (await isAtCapacity(strapi, event, user.id)) {
        return ctx.badRequest("Event is at capacity");
      }
    }

    const respondedAt = new Date().toISOString();
    if (existing) {
      const updated = await strapi.db.query(RSVP_UID).update({
        where: { id: existing.id },
        data: { status, respondedAt },
      });
      return ctx.send({ data: updated });
    }

    // Single-row db.query create — attaches the user relation correctly
    // (createMany would NOT link relations). REAL, accepted tolerance of
    // the check-then-insert race (no unique DB constraint spans the user
    // link table): two concurrent first answers can insert two rows for
    // the same (user, targetDocumentId), and two concurrent "yes" switches
    // can overshoot a capacity by one (poll-vote precedent). Duplicates
    // are healed by the findMany cleanup above on the user's next upsert;
    // until then consumers (events page summary) dedupe by user id keeping
    // the latest respondedAt, and countYesUsers counts distinct users.
    const created = await strapi.db.query(RSVP_UID).create({
      data: { user: user.id, targetDocumentId, status, respondedAt },
    });
    return ctx.send({ data: created });
  },

  /**
   * Core update route, ownership-gated by `global::is-event-rsvp-owner`.
   * The web app only uses the upsert above; this keeps the granted PUT
   * route safe for direct API consumers: only `status` is writable
   * (user/targetDocumentId stay pinned), the capacity gate applies to a
   * switch into "yes", and respondedAt is set server-side.
   */
  async update(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    // The web app addresses records by numeric id, but the v5 core
    // controller resolves by documentId — translate before delegating
    // (comment controller gotcha).
    const idParam = String(ctx.params.id);
    const entity = await strapi.db.query(RSVP_UID).findOne({
      where: /^\d+$/.test(idParam) ? { id: Number(idParam) } : { documentId: idParam },
    });
    if (!entity) return ctx.notFound();

    const body = (ctx.request.body ?? {}) as any;
    const input = body.data ?? body;
    const status = input?.status;
    if (!isRsvpStatus(status)) return ctx.badRequest("Invalid status");

    if (status === "yes" && entity.status !== "yes") {
      const event = await strapi.db.query(EVENT_UID).findOne({
        where: { documentId: entity.targetDocumentId, publishedAt: { $notNull: true } },
      });
      if (!event || !event.rsvpEnabled) {
        return ctx.badRequest("Event not available for RSVP");
      }
      if (await isAtCapacity(strapi, event, user.id)) {
        return ctx.badRequest("Event is at capacity");
      }
    }

    ctx.params.id = entity.documentId;
    ctx.request.body = {
      data: { status, respondedAt: new Date().toISOString() },
    };
    return super.update(ctx);
  },
}));
