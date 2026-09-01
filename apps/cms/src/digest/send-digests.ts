/**
 * Digest orchestrator (issue #18), fired by the `digest-mailer` cron
 * every morning. Sequential per user (≤ dozens of recipients on this
 * intranet; no herd against mailcow), per-user try/catch — one broken
 * mailbox never blocks the rest.
 *
 * Idempotency (AC "survives container restarts"): `lastDigestAt` on the
 * user row is the only state, advanced AFTER a successful send. Crash
 * between send and update ⇒ at most ONE duplicate digest for that user
 * on the next run; a crash earlier ⇒ the user is simply picked up
 * again. No in-memory state.
 *
 * Audience correctness: announcements are filtered per recipient with
 * the SAME primitives the API uses (`loadUserScope` +
 * `isAnnouncementVisible`) — a department-scoped post never reaches an
 * out-of-audience inbox.
 *
 * Off switch: without SMTP_HOST/SMTP_USER/SMTP_PASS (or with
 * DIGESTS_DISABLED=1) the run is a logged no-op — the feature ships
 * dark until the mailbox app-password lands in infra/.env.
 */

import { isAnnouncementVisible } from "../utils/announcement-audience";
import { loadUserScope } from "../utils/visible-ids";
import { digestWindowStart, isDigestDue, wantsAnyDigest } from "./digest-plan";
import { renderDigest, totalItems, type DigestContent } from "./render-digest";

const USER_UID = "plugin::users-permissions.user";

function digestsEnabled(): { enabled: boolean; reason?: string } {
  if (process.env.DIGESTS_DISABLED === "1") return { enabled: false, reason: "DIGESTS_DISABLED=1" };
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return { enabled: false, reason: "SMTP env incomplete (SMTP_HOST/USER/PASS)" };
  }
  return { enabled: true };
}

async function collectContent(
  strapi: any,
  user: any,
  since: Date,
  now: Date,
): Promise<DigestContent> {
  const sinceIso = since.toISOString();
  const nowIso = now.toISOString();
  const content: DigestContent = { announcements: [], mentions: [], kudos: [] };

  if (user.digestAnnouncements) {
    const [rows, rawScope] = await Promise.all([
      strapi.db.query("api::announcement.announcement").findMany({
        where: { publishedAt: { $gte: sinceIso, $lt: nowIso } },
        select: ["id", "title", "audience", "publishedAt"],
        populate: {
          department: { select: ["id"] },
          team: { select: ["id"] },
          audienceRoles: { select: ["id"] },
          author: { select: ["displayName"] },
        },
        orderBy: { publishedAt: "desc" },
        limit: 25,
      }),
      loadUserScope(strapi, user.id),
    ]);
    const scope = {
      roleId: rawScope.roleId,
      departmentId: rawScope.departmentId,
      teamIds: [...rawScope.teamIds, ...rawScope.ledTeamIds],
    };
    content.announcements = rows
      .filter((a: any) => isAnnouncementVisible(a, scope))
      .map((a: any) => ({ title: a.title, author: a.author?.displayName ?? null }));
  }

  if (user.digestMentions) {
    const rows = await strapi.db.query("api::notification.notification").findMany({
      where: {
        recipient: user.id,
        type: "comment",
        createdAt: { $gte: sinceIso, $lt: nowIso },
      },
      select: ["id", "title"],
      orderBy: { createdAt: "desc" },
      limit: 25,
    });
    content.mentions = rows.map((r: any) => ({ title: r.title }));
  }

  if (user.digestKudos) {
    const rows = await strapi.db.query("api::kudos.kudos").findMany({
      where: { to: user.id, createdAt: { $gte: sinceIso, $lt: nowIso } },
      select: ["id", "message", "value"],
      populate: { from: { select: ["displayName"] } },
      orderBy: { createdAt: "desc" },
      limit: 25,
    });
    content.kudos = rows.map((r: any) => ({
      message: r.message,
      value: r.value,
      from: r.from?.displayName ?? null,
    }));
  }

  return content;
}

export async function sendDigests(strapi: any, now = new Date()): Promise<void> {
  const gate = digestsEnabled();
  if (!gate.enabled) {
    strapi.log.info(`[digest] skipped: ${gate.reason}`);
    return;
  }

  const candidates = await strapi.db.query(USER_UID).findMany({
    where: {
      blocked: { $ne: true },
      $or: [
        { digestAnnouncements: true },
        { digestMentions: true },
        { digestKudos: true },
      ],
    },
    select: [
      "id",
      "email",
      "displayName",
      "username",
      "locale",
      "blocked",
      "digestAnnouncements",
      "digestMentions",
      "digestKudos",
      "digestFrequency",
      "lastDigestAt",
    ],
  });

  const baseUrl = process.env.PUBLIC_WEB_URL || "https://sinnlos.yurtbay.dev";
  let sent = 0;
  let empty = 0;
  let failed = 0;
  let skipped = 0;

  for (const user of candidates) {
    try {
      if (!wantsAnyDigest(user) || !isDigestDue(user, now)) {
        skipped++;
        continue;
      }
      const since = digestWindowStart(user, now);
      const content = await collectContent(strapi, user, since, now);
      if (totalItems(content) === 0) {
        // Nothing to say → no mail, and lastDigestAt deliberately stays
        // put so the next digest window covers the quiet span too.
        empty++;
        continue;
      }
      const rendered = renderDigest(content, {
        displayName: user.displayName || user.username || user.email,
        locale: user.locale,
        baseUrl,
      });
      await strapi.plugin("email").service("email").send({
        to: user.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
      await strapi.db.query(USER_UID).update({
        where: { id: user.id },
        data: { lastDigestAt: now.toISOString() },
      });
      sent++;
    } catch (err) {
      failed++;
      strapi.log.warn(`[digest] user ${user.id} failed: ${(err as Error).message}`);
    }
  }

  strapi.log.info(
    `[digest] run complete: sent=${sent} empty=${empty} skipped=${skipped} failed=${failed} of ${candidates.length} candidate(s)`,
  );
}
