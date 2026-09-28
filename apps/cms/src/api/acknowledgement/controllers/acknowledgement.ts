import { factories } from "@strapi/strapi";

import {
  hasAudienceBypass,
  isAnnouncementVisible,
  type AnnouncementTargeting,
} from "../../../utils/announcement-audience";
import { loadUserScope } from "../../../utils/visible-ids";

/**
 * Acknowledgements follow the poll-vote integrity pattern: the caller can
 * NEVER pick the acknowledging user — it is always taken from
 * ctx.state.user, and duplicates / invalid targets are rejected
 * server-side.
 *
 * Target anchoring — documentId, NOT the numeric id:
 *   Strapi 5 publishes by DELETING and RE-CREATING the published row, so
 *   the numeric `id` of a published entry changes on every re-publish. An
 *   ack anchored to the numeric id would silently detach from its
 *   announcement the next time an editor hits "Publish". The `documentId`
 *   is stable across the whole draft/publish lifecycle, so acks reference
 *   `targetType` + `targetDocumentId` (string) instead.
 */
const TARGET_UIDS: Record<string, string> = {
  announcement: "api::announcement.announcement",
  document: "api::document.document",
};

/** The announcement relations its targeting rules read (announcement-audience.ts). */
const ANNOUNCEMENT_TARGETING = {
  department: { select: ["id"] },
  team: { select: ["id"] },
  audienceRoles: { select: ["id"] },
};

interface AckCaller {
  id: number;
  role?: { type?: string } | null;
}

/**
 * May the caller see the target (FX27)? An announcement only its audience
 * may acknowledge, decided by the rules every announcement read uses
 * (utils/announcement-audience.ts: admin_role/editor bypass, else department
 * AND team (member or lead) AND role over whatever is set). The scope mapping
 * is the one of target-visibility.ts toAudienceScope. Any other target type
 * fails closed: documents have no requiresAck yet, and would need their own
 * visibility rules here once they do.
 */
async function isInAudience(
  strapi: unknown,
  targetType: string,
  target: AnnouncementTargeting,
  user: AckCaller,
): Promise<boolean> {
  if (targetType !== "announcement") return false;
  if (hasAudienceBypass(user.role?.type)) return true;
  const scope = await loadUserScope(strapi, user.id);
  return isAnnouncementVisible(target, {
    roleId: scope.roleId,
    departmentId: scope.departmentId,
    teamIds: [...scope.teamIds, ...scope.ledTeamIds],
  });
}

export default factories.createCoreController(
  "api::acknowledgement.acknowledgement",
  ({ strapi }) => ({
    async create(ctx) {
      const user = ctx.state.user;
      if (!user) return ctx.unauthorized();

      const body = (ctx.request.body ?? {}) as any;
      const data = body.data ?? body;
      const targetType = data?.targetType as string | undefined;
      const targetDocumentId = data?.targetDocumentId;

      // Own keys only (FX27): a plain index also found inherited keys, so
      // "constructor" or "__proto__" reached the query and failed with a 500.
      const targetUid =
        typeof targetType === "string" &&
        Object.prototype.hasOwnProperty.call(TARGET_UIDS, targetType)
          ? TARGET_UIDS[targetType]
          : undefined;
      if (!targetUid) return ctx.badRequest("Invalid targetType");
      if (typeof targetDocumentId !== "string" || targetDocumentId.length === 0) {
        return ctx.badRequest("targetDocumentId required");
      }

      // The target must exist as a PUBLISHED entry and actually require
      // acknowledgement. Documents currently have no requiresAck field, so
      // document acks are rejected here until the schema grows one — the
      // enum value is only prepared.
      const target = await strapi.db.query(targetUid).findOne({
        where: { documentId: targetDocumentId, publishedAt: { $notNull: true } },
        ...(targetType === "announcement" ? { populate: ANNOUNCEMENT_TARGETING } : {}),
      });
      // Deliberately ONE identical error (message + status) for all four
      // failure modes — "does not exist", "draft only", "requiresAck=false"
      // and "not in the caller's audience" (FX27) — so the endpoint is no
      // existence oracle for draft documentIds or hidden announcements.
      if (
        !target ||
        !target.requiresAck ||
        !(await isInAudience(strapi, targetType, target, user))
      ) {
        return ctx.badRequest("Target not available for acknowledgement");
      }

      // One acknowledgement per user + target.
      //
      // NOTE — accepted check-then-insert race (same pattern as the
      // poll-vote controller): two concurrent creates for the same
      // (user, targetType, targetDocumentId) can both pass this check and
      // insert two rows. A DB unique index would be the airtight fix, but
      // `user` is a relation via a link table, so there is no single-table
      // column set to index without fighting Strapi's schema management.
      // All consumers (dashboard banner, /announcements page, admin
      // report) dedupe by Set/Map over targetDocumentId, so a duplicate
      // row is cosmetic, never a correctness issue.
      const existing = await strapi.db
        .query("api::acknowledgement.acknowledgement")
        .findOne({ where: { user: user.id, targetType, targetDocumentId } });
      if (existing) return ctx.badRequest("Already acknowledged");

      // Single-row db.query create — attaches the user relation correctly
      // (createMany would NOT link relations).
      const ack = await strapi.db.query("api::acknowledgement.acknowledgement").create({
        data: {
          user: user.id,
          targetType,
          targetDocumentId,
          acknowledgedAt: new Date().toISOString(),
        },
      });
      return ctx.send({ data: ack });
    },
  }),
);
