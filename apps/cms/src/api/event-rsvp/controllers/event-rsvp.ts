import { factories } from "@strapi/strapi";

import { parseEntryRef } from "../../../utils/entry-id";
import {
  capacityDecision,
  distinctYesUsers,
  isRsvpStatus,
  newestFirst,
  parseSummaryTargets,
  requestsLegacyFormat,
  stripPrivateUsers,
  summarizeRsvps,
  type RsvpRow,
} from "../../../utils/rsvp";

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

/**
 * Count how many DISTINCT users currently answer "yes" for the event,
 * excluding `excludeUserId` (the caller — their own switch to "yes" must
 * not count against themselves). Distinct users, not rows: the accepted
 * check-then-insert race (below) can leave duplicate rows per user until
 * the next upsert heals them (utils/rsvp.ts distinctYesUsers).
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
  return distinctYesUsers(rows, excludeUserId);
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
const LEGACY_FORMAT_MESSAGE = "Strapi-Response-Format is not supported here";

/**
 * The raw reads refuse the Strapi-Response-Format header for every role but
 * admin_role (FX21), so they only ever answer in the response shape the
 * backstop post-filter below is written for (utils/rsvp.ts
 * requestsLegacyFormat).
 */
function refusesLegacyFormat(ctx: {
  headers?: unknown;
  state?: { user?: { role?: { type?: unknown } | null } | null };
}): boolean {
  if (ctx.state?.user?.role?.type === "admin_role") return false;
  return requestsLegacyFormat(ctx.headers);
}

async function isAtCapacity(strapi: any, event: any, userId: number): Promise<boolean> {
  // Without a limit no user count can fill the event: skip the query.
  if (capacityDecision(event.capacity, Number.MAX_SAFE_INTEGER) === "open") return false;
  const yesUsers = await countYesUsers(strapi, event.documentId, userId);
  return capacityDecision(event.capacity, yesUsers) === "full";
}

export default factories.createCoreController(RSVP_UID, ({ strapi }) => ({
  /**
   * GET /api/event-rsvps/summary?targets=<documentIds> (FX21): per event the
   * counts, the names of the "yes" answers and the caller's own answer,
   * aggregated here instead of shipping every row to the web (which walked
   * up to 3000 rows per view). Decliners stay private: no maybe/no name
   * ever leaves the CMS (utils/rsvp.ts summarizeRsvps).
   *
   * Only PUBLISHED events are summarised; a missing or draft-only target is
   * left out of the answer, identically, so the endpoint is no existence
   * oracle for draft documentIds. Granted like event-rsvp find
   * (CUSTOM_ACTION_GRANTS, never guest); no route policy, the rows are
   * read through strapi.db.query and only the aggregate is returned.
   */
  async summary(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const parsed = parseSummaryTargets(ctx.query?.targets);
    if ("error" in parsed) return ctx.badRequest(parsed.error);

    const events: { documentId: string }[] = await strapi.db.query(EVENT_UID).findMany({
      where: { documentId: { $in: parsed.targets }, publishedAt: { $notNull: true } },
      select: ["documentId"],
    });
    const published = new Set(events.map((event) => event.documentId));
    const targets = parsed.targets.filter((target) => published.has(target));
    if (targets.length === 0) return ctx.send({ data: [] });

    const rows: RsvpRow[] = await strapi.db.query(RSVP_UID).findMany({
      where: { targetDocumentId: { $in: targets } },
      select: ["id", "targetDocumentId", "status", "respondedAt"],
      populate: { user: { select: ["id", "displayName"] } },
    });
    const callerId = typeof user.id === "number" ? user.id : null;
    return ctx.send({ data: summarizeRsvps(rows, targets, callerId) });
  },

  /**
   * Core find. The route policy (global::event-rsvp-own-rows) already
   * narrowed it to the caller's own rows (admin_role: all rows) and refused
   * a user filter; the legacy v4 response shape is refused here, and other
   * people's maybe/no users are still stripped as a backstop
   * (stripPrivateUsers in utils/rsvp.ts).
   */
  async find(ctx) {
    if (refusesLegacyFormat(ctx)) return ctx.badRequest(LEGACY_FORMAT_MESSAGE);
    const response = await super.find(ctx);
    if (Array.isArray(response?.data)) {
      stripPrivateUsers(response.data, ctx.state.user);
    }
    return response;
  },

  /** Core findOne, guarded and post-filtered the same way as find. */
  async findOne(ctx) {
    if (refusesLegacyFormat(ctx)) return ctx.badRequest(LEGACY_FORMAT_MESSAGE);
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
    // (utils/rsvp.ts pickSurvivor's order).
    const existingRows: RsvpRow[] = newestFirst(
      await strapi.db.query(RSVP_UID).findMany({
        where: { user: user.id, targetDocumentId },
      }),
    );
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
    // (comment controller gotcha). A malformed id is an unknown RSVP and
    // never reaches the query (utils/entry-id.ts).
    const where = parseEntryRef(ctx.params.id);
    if (!where) return ctx.notFound();
    const entity = await strapi.db.query(RSVP_UID).findOne({ where });
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
