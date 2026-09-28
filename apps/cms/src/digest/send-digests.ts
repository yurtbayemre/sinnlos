/**
 * Digest orchestrator (issue #18), fired by the `digest-mailer` cron
 * every morning. Sequential per user (≤ dozens of recipients on this
 * intranet; no herd against mailcow), per-user try/catch — one broken
 * mailbox never blocks the rest.
 *
 * Idempotency (AC "survives container restarts"): `lastDigestAt` on the
 * user row is the only state, advanced AFTER a successful send and set to
 * the window's `now`. Crash between send and update ⇒ at most ONE
 * duplicate digest for that user on the next run; a crash earlier ⇒ the
 * user is simply picked up again. An empty digest sends nothing and keeps
 * lastDigestAt, so the next window covers the quiet span too. No in-memory
 * state.
 *
 * Recipients (FX19): an opted-in, due user whose role holds
 * announcement.find (read from up_permissions at runtime, once per run) and
 * who is neither blocked nor a guest. The kudos section additionally needs
 * kudos.find. Announcements are filtered per recipient with the SAME rules
 * as the API (`isAnnouncementVisible` over member-or-lead teams); admin_role
 * and editor get strictly the targeted audience (owner default).
 *
 * Per run, not per user (FX48): the candidates, every active user's scope
 * (loadAllUserScopes: users + team-lead map), the grants, the announcements
 * of the widest window and the notifications that anchor them are read
 * ONCE. Per user: filter by the user's window (since), then the audience,
 * then drop republished announcements, then cap at 25 with "+N more" in the
 * mail. Before, the SQL limit of 25 ran before the audience filter, so a
 * visible announcement behind 25 newer ones for other audiences never
 * arrived. Mentions and kudos stay per-user queries (they filter by the
 * recipient in SQL).
 *
 * Republished announcements (FX48): Strapi publishes by delete + recreate
 * and stamps a new publishedAt, so an edited announcement re-entered the
 * next digest as news. It is dropped for a user who already holds an
 * announcement notification anchored to its documentId (§5.26) from before
 * the user's window: the fan-out told them about it earlier. The fan-out
 * never notifies the author, so the author's own announcement is dropped
 * once ANY recipient's anchor predates the author's window (it was
 * published, and in the author's digest, before). Announcements from
 * before the #12 anchors, and a user who joined the audience later (the
 * republish's fan-out notifies them), still see a republish once.
 *
 * Off switch: without SMTP_HOST/SMTP_USER/SMTP_PASS (or with
 * DIGESTS_DISABLED=1, or true/yes/on) the run is a logged no-op — the feature ships
 * dark until the mailbox app-password lands in infra/.env. The gate runs
 * before any DB or SMTP access.
 *
 * No owner-domain fallbacks (FX13): the link base (PUBLIC_WEB_URL; compose
 * defaults it to WEB_PUBLIC_URL) and the sender (DIGEST_FROM) come from env
 * only. With SMTP configured but either of them unset the run is skipped
 * instead of mailing links to / from someone else's domain. That skip is an
 * ERROR log, repeated once at boot (FX13 review): a live env that relied on
 * the removed DIGEST_FROM compose default would otherwise lose its digests
 * with nothing louder than a daily warning.
 */

import { GUEST, hasRole, type RoleType } from "../bootstrap/roles";
import { isAnnouncementVisible, type AnnouncementTargeting } from "../utils/announcement-audience";
import { instantMsOrNull } from "../utils/time";
import {
  ANNOUNCEMENT_FIND,
  KUDOS_FIND,
  NOT_BLOCKED,
  audienceScopeOf,
  holdsGrant,
  loadAllUserScopes,
  loadRoleGrants,
  type RecipientScope,
  type RoleGrants,
  type ScopeStrapi,
} from "../utils/visible-ids";
import {
  digestWindowStart,
  isDigestDue,
  wantsAnyDigest,
  type DigestUserFlags,
} from "./digest-plan";
import { renderDigest, totalItems, type DigestContent } from "./render-digest";

const USER_UID = "plugin::users-permissions.user";
const ANNOUNCEMENT_UID = "api::announcement.announcement";
const NOTIFICATION_UID = "api::notification.notification";
const KUDOS_UID = "api::kudos.kudos";

/** Announcements per digest; the rest is summarised as "+N more". */
export const DIGEST_ANNOUNCEMENT_CAP = 25;

/** Role types that never get a digest, whatever up_permissions says (FX19). */
export const DIGEST_EXCLUDED_ROLE_TYPES: readonly RoleType[] = [GUEST];

/**
 * `skip`: intentionally dark (kill switch / no SMTP) → info log.
 * `misconfigured`: SMTP is set but the link base or sender is missing → error.
 */
export type DigestGate =
  | { kind: "send"; baseUrl: string }
  | { kind: "skip" | "misconfigured"; reason: string };

/**
 * An on/off env switch (B05): "1", "true", "yes" and "on" (any case,
 * surrounding blanks ignored) switch it on; anything else, unset included,
 * leaves it off. "1" is what compose, the docs and infra/deploy.sh use.
 */
export function parseEnvFlag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function digestsEnabled(env: Record<string, string | undefined> = process.env): DigestGate {
  if (parseEnvFlag(env.DIGESTS_DISABLED)) {
    return { kind: "skip", reason: `DIGESTS_DISABLED=${(env.DIGESTS_DISABLED ?? "").trim()}` };
  }
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    return { kind: "skip", reason: "SMTP env incomplete (SMTP_HOST/USER/PASS)" };
  }
  const baseUrl = (env.PUBLIC_WEB_URL ?? "").trim();
  if (!baseUrl) {
    return {
      kind: "misconfigured",
      reason:
        "PUBLIC_WEB_URL unset — digest links need the web origin (e.g. https://intranet.example.com)",
    };
  }
  if (!(env.DIGEST_FROM ?? "").trim()) {
    return {
      kind: "misconfigured",
      reason: 'DIGEST_FROM unset — set the sender, e.g. "Intranet <noreply@example.com>"',
    };
  }
  return { kind: "send", baseUrl };
}

/**
 * Boot-time echo of the gate (called from bootstrap), so a misconfigured
 * sender shows up right after a deploy rather than at the next 07:30 run.
 * Env only — no DB or SMTP access.
 */
export function reportDigestConfig(
  log: { error(message: string): void },
  env: Record<string, string | undefined> = process.env,
): void {
  const gate = digestsEnabled(env);
  if (gate.kind === "misconfigured") {
    log.error(`[digest] misconfigured, every digest run will be skipped: ${gate.reason}`);
  }
}

/** One candidate row (the select below). */
export interface DigestUser extends DigestUserFlags {
  id: number;
  displayName?: string | null;
  username?: string | null;
  locale?: string | null;
}

/** One announcement of the run's window (the select below). */
export interface DigestAnnouncement extends AnnouncementTargeting {
  id: number;
  documentId?: string | null;
  title?: string | null;
  publishedAt: string;
  author?: { id?: number | null; displayName?: string | null } | null;
}

/**
 * Whether a due user gets a digest at all (FX19): not blocked (only active
 * users have a scope), not a guest, and the role holds announcement.find.
 */
export function isDigestRecipient(
  scope: RecipientScope | undefined,
  announcementReaders: ReadonlySet<number>,
): scope is RecipientScope {
  if (!scope) return false;
  if (hasRole({ role: { type: scope.roleType } }, DIGEST_EXCLUDED_ROLE_TYPES)) return false;
  return holdsGrant(scope, announcementReaders);
}

/**
 * The announcements section of one user (pure): newest first, published in
 * [since, now) (the run's query already ends at now), visible to the user,
 * not a republish they were told about before `since`, at most `cap`;
 * `more` counts the rest.
 *
 * `notifiedAt` maps a documentId to the earliest instant (ms) this user got
 * an announcement notification anchored to it; `firstNotifiedAt` to the
 * earliest one of ANY recipient, which decides for the author (whom the
 * fan-out never notifies).
 */
export function selectAnnouncements(
  rows: readonly DigestAnnouncement[],
  options: {
    since: Date;
    scope: RecipientScope;
    notifiedAt: ReadonlyMap<string, number>;
    firstNotifiedAt?: ReadonlyMap<string, number>;
    cap?: number;
  },
): { items: DigestContent["announcements"]; more: number } {
  const sinceMs = options.since.getTime();
  const audience = audienceScopeOf(options.scope);
  const seen = new Set<string>();
  const selected: DigestAnnouncement[] = [];
  for (const row of rows) {
    const publishedMs = instantMsOrNull(row.publishedAt);
    if (publishedMs == null || publishedMs < sinceMs) continue;
    if (!isAnnouncementVisible(row, audience)) continue;
    const documentId = row.documentId ?? null;
    if (documentId != null) {
      if (seen.has(documentId)) continue;
      seen.add(documentId);
      const notified = options.notifiedAt.get(documentId);
      if (notified != null && notified < sinceMs) continue;
      if (row.author?.id != null && row.author.id === options.scope.userId) {
        const first = options.firstNotifiedAt?.get(documentId);
        if (first != null && first < sinceMs) continue;
      }
    }
    selected.push(row);
  }
  const cap = options.cap ?? DIGEST_ANNOUNCEMENT_CAP;
  return {
    items: selected
      .slice(0, cap)
      .map((row) => ({ title: row.title ?? "", author: row.author?.displayName ?? null })),
    more: Math.max(0, selected.length - cap),
  };
}

interface NotifiedRow {
  sourceDocumentId?: string | null;
  createdAt?: string | null;
  recipient?: { id?: number } | null;
}

interface NotifiedIndex {
  /** user id → documentId → earliest notification instant (ms). */
  byUser: Map<number, Map<string, number>>;
  /** documentId → earliest notification instant (ms) of any recipient. */
  first: Map<string, number>;
}

function notifiedIndex(rows: readonly NotifiedRow[]): NotifiedIndex {
  const byUser = new Map<number, Map<string, number>>();
  const first = new Map<string, number>();
  for (const row of rows) {
    const documentId = row.sourceDocumentId;
    const createdMs = instantMsOrNull(row.createdAt);
    if (!documentId || createdMs == null) continue;
    const earliest = first.get(documentId);
    if (earliest == null || createdMs < earliest) first.set(documentId, createdMs);
    const userId = row.recipient?.id;
    if (typeof userId !== "number") continue;
    const perUser = byUser.get(userId) ?? new Map<string, number>();
    const earlier = perUser.get(documentId);
    if (earlier == null || createdMs < earlier) perUser.set(documentId, createdMs);
    byUser.set(userId, perUser);
  }
  return { byUser, first };
}

/** The slice of the Strapi instance the orchestrator uses. */
export interface DigestStrapi extends ScopeStrapi {
  db: {
    query(uid: string): {
      findMany(params: Record<string, unknown>): Promise<unknown>;
      update(params: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }): Promise<unknown>;
    };
  };
  plugin(name: string): { service(name: string): object };
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
}

interface EmailService {
  send(options: { to: string; subject: string; text: string; html: string }): Promise<unknown>;
}

const listOf = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

interface Due {
  user: DigestUser;
  scope: RecipientScope;
  since: Date;
}

/**
 * The run-wide reads for the announcements section: the announcements of
 * the widest window and the notifications that anchor them from before the
 * latest window start (the only ones the republish check can use).
 */
async function loadAnnouncementWindow(
  strapi: DigestStrapi,
  due: readonly Due[],
  now: Date,
): Promise<{ rows: DigestAnnouncement[]; notified: NotifiedIndex }> {
  const none = (): NotifiedIndex => ({ byUser: new Map(), first: new Map() });
  const wanting = due.filter((entry) => entry.user.digestAnnouncements);
  if (wanting.length === 0) return { rows: [], notified: none() };
  const starts = wanting.map((entry) => entry.since.getTime());
  const widest = new Date(Math.min(...starts));
  const latest = new Date(Math.max(...starts));

  const rows = listOf<DigestAnnouncement>(
    await strapi.db.query(ANNOUNCEMENT_UID).findMany({
      where: { publishedAt: { $gte: widest.toISOString(), $lt: now.toISOString() } },
      select: ["id", "documentId", "title", "audience", "publishedAt"],
      populate: {
        department: { select: ["id"] },
        team: { select: ["id"] },
        audienceRoles: { select: ["id"] },
        author: { select: ["id", "displayName"] },
      },
      orderBy: { publishedAt: "desc" },
    }),
  );
  const documentIds = [
    ...new Set(rows.map((row) => row.documentId).filter((id): id is string => !!id)),
  ];
  if (documentIds.length === 0) return { rows, notified: none() };
  const notifications = listOf<NotifiedRow>(
    await strapi.db.query(NOTIFICATION_UID).findMany({
      where: {
        sourceType: "announcement",
        sourceDocumentId: { $in: documentIds },
        createdAt: { $lt: latest.toISOString() },
      },
      select: ["sourceDocumentId", "createdAt"],
      populate: { recipient: { select: ["id"] } },
    }),
  );
  return { rows, notified: notifiedIndex(notifications) };
}

async function collectMentionsAndKudos(
  strapi: DigestStrapi,
  entry: Due,
  now: Date,
  kudosReaders: ReadonlySet<number>,
  content: DigestContent,
): Promise<void> {
  const { user, scope, since } = entry;
  const sinceIso = since.toISOString();
  const nowIso = now.toISOString();

  if (user.digestMentions) {
    const rows = listOf<{ title?: string | null }>(
      await strapi.db.query(NOTIFICATION_UID).findMany({
        where: {
          recipient: user.id,
          type: "comment",
          createdAt: { $gte: sinceIso, $lt: nowIso },
        },
        select: ["id", "title"],
        orderBy: { createdAt: "desc" },
        limit: 25,
      }),
    );
    content.mentions = rows.map((row) => ({ title: row.title ?? "" }));
  }

  // The kudos section needs the kudos read grant (guest never had it).
  if (user.digestKudos && holdsGrant(scope, kudosReaders)) {
    const rows = listOf<{
      message?: string | null;
      value?: string | null;
      from?: { displayName?: string | null } | null;
    }>(
      await strapi.db.query(KUDOS_UID).findMany({
        where: { to: user.id, createdAt: { $gte: sinceIso, $lt: nowIso } },
        select: ["id", "message", "value"],
        populate: { from: { select: ["displayName"] } },
        orderBy: { createdAt: "desc" },
        limit: 25,
      }),
    );
    content.kudos = rows.map((row) => ({
      message: row.message ?? "",
      value: row.value ?? null,
      from: row.from?.displayName ?? null,
    }));
  }
}

export async function sendDigests(strapi: DigestStrapi, now = new Date()): Promise<void> {
  const gate = digestsEnabled();
  if (gate.kind !== "send") {
    if (gate.kind === "misconfigured") strapi.log.error(`[digest] skipped: ${gate.reason}`);
    else strapi.log.info(`[digest] skipped: ${gate.reason}`);
    return;
  }

  const candidates = listOf<DigestUser>(
    await strapi.db.query(USER_UID).findMany({
      where: {
        $and: [
          NOT_BLOCKED,
          {
            $or: [{ digestAnnouncements: true }, { digestMentions: true }, { digestKudos: true }],
          },
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
    }),
  );

  const baseUrl = gate.baseUrl;
  let sent = 0;
  let empty = 0;
  let failed = 0;
  let skipped = 0;

  const dueUsers = candidates.filter((user) => wantsAnyDigest(user) && isDigestDue(user, now));
  skipped += candidates.length - dueUsers.length;

  let recipients: [RecipientScope[], RoleGrants] | null = null;
  if (dueUsers.length > 0) {
    try {
      // Run-wide reads (FX48): scopes, grants, announcements, anchors — once.
      recipients = await Promise.all([
        loadAllUserScopes(strapi),
        loadRoleGrants(strapi, [ANNOUNCEMENT_FIND, KUDOS_FIND]),
      ]);
    } catch (err) {
      // Nobody's audience or grants are known: every due user fails this
      // run and keeps lastDigestAt, and the run still ends with its summary.
      failed += dueUsers.length;
      strapi.log.error(`[digest] could not load the recipients: ${(err as Error).message}`);
    }
  }

  if (recipients != null) {
    const [scopes, grants] = recipients;
    const scopeById = new Map(scopes.map((scope) => [scope.userId, scope]));
    const announcementReaders = grants.holders(ANNOUNCEMENT_FIND);
    const kudosReaders = grants.holders(KUDOS_FIND);

    const due: Due[] = [];
    for (const user of dueUsers) {
      const scope = scopeById.get(user.id);
      if (!isDigestRecipient(scope, announcementReaders)) {
        skipped++;
        continue;
      }
      due.push({ user, scope, since: digestWindowStart(user, now) });
    }

    let window: Awaited<ReturnType<typeof loadAnnouncementWindow>> | null = null;
    try {
      window = await loadAnnouncementWindow(strapi, due, now);
    } catch (err) {
      // Without the announcements the digest of everyone who wants them
      // would be incomplete: those users get none this run and keep their
      // lastDigestAt, so the next run covers the span.
      strapi.log.error(`[digest] could not load the announcements: ${(err as Error).message}`);
    }

    for (const entry of due) {
      const { user } = entry;
      if (user.digestAnnouncements && window == null) {
        failed++;
        continue;
      }
      try {
        const content: DigestContent = { announcements: [], mentions: [], kudos: [] };
        if (user.digestAnnouncements && window != null) {
          const { items, more } = selectAnnouncements(window.rows, {
            since: entry.since,
            scope: entry.scope,
            notifiedAt: window.notified.byUser.get(user.id) ?? new Map(),
            firstNotifiedAt: window.notified.first,
          });
          content.announcements = items;
          if (more > 0) content.announcementsMore = more;
        }
        await collectMentionsAndKudos(strapi, entry, now, kudosReaders, content);
        if (totalItems(content) === 0) {
          // Nothing to say → no mail, and lastDigestAt deliberately stays
          // put so the next digest window covers the quiet span too.
          empty++;
          continue;
        }
        const rendered = renderDigest(content, {
          displayName: user.displayName || user.username || user.email || "",
          locale: user.locale,
          baseUrl,
        });
        const email = strapi.plugin("email").service("email") as EmailService;
        await email.send({
          to: user.email ?? "",
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
  }

  strapi.log.info(
    `[digest] run complete: sent=${sent} empty=${empty} skipped=${skipped} failed=${failed} of ${candidates.length} candidate(s)`,
  );
}
