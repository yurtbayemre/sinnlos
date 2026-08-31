/**
 * Fire-and-forget push of *content-free* change pings to the Next.js
 * live-event bus (`/api/live/emit`), which fans them out to open SSE
 * streams. Clients react by refetching through their own session/JWT,
 * so every visibility policy applies by construction — these events
 * carry no content, only "something on channel X changed".
 *
 * Shares WEB_INTERNAL_URL + REVALIDATE_SECRET with utils/revalidate.ts
 * (the secret guards both internal endpoints; rotation affects both).
 * Unlike revalidate.ts this logs non-2xx responses: the whole pipeline
 * is fire-and-forget, so a silently failing emit would present as a
 * perfectly healthy app that just never updates (see issue #17 plan).
 *
 * Events are micro-batched (100ms) and deduped per channel: a single
 * announcement publish fans out to N notification rows, and the seed /
 * bulk paths fire the DB lifecycle subscriber too — without batching
 * that would be N POSTs instead of one.
 */

export type LiveEvent =
  | { kind: "content"; targetType: string; targetDocumentId: string }
  | { kind: "notification"; recipientId: number }
  | { kind: "announcements" };

const BATCH_WINDOW_MS = 100;

let pending = new Map<string, LiveEvent>();
let timer: NodeJS.Timeout | null = null;

function dedupeKey(event: LiveEvent): string {
  switch (event.kind) {
    case "content":
      return `c:${event.targetType}:${event.targetDocumentId}`;
    case "notification":
      return `n:${event.recipientId}`;
    case "announcements":
      return "a";
  }
}

function liveEventsEnabled(): boolean {
  return (
    !!process.env.WEB_INTERNAL_URL &&
    !!process.env.REVALIDATE_SECRET &&
    process.env.LIVE_EVENTS_DISABLED !== "1"
  );
}

async function flush(): Promise<void> {
  timer = null;
  if (pending.size === 0) return;
  const events = [...pending.values()];
  pending = new Map();

  const webUrl = process.env.WEB_INTERNAL_URL;
  const secret = process.env.REVALIDATE_SECRET;
  if (!webUrl || !secret) return;

  try {
    const res = await fetch(`${webUrl}/api/live/emit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-revalidate-secret": secret,
      },
      body: JSON.stringify({ events }),
      // Short timeout — a slow/absent frontend must never slow down or
      // fail Strapi's write path.
      signal: AbortSignal.timeout(3000),
      // The web middleware answers unauthenticated paths with redirects;
      // following one would masquerade a misroute as success.
      redirect: "manual",
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `[live-emit] status=${res.status} for ${events.length} event(s) — live pings are NOT reaching the web bus`,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[live-emit] failed (${events.length} event(s)): ${(err as Error).message}`);
  }
}

/**
 * Queue a live event. Never throws, never blocks the caller's write
 * transaction (the actual POST happens on a detached timer).
 */
export function emitLiveEvent(event: LiveEvent): void {
  if (!liveEventsEnabled()) return;
  pending.set(dedupeKey(event), event);
  if (!timer) {
    timer = setTimeout(() => {
      void flush();
    }, BATCH_WINDOW_MS);
    // Never keep the process alive just for a pending ping.
    timer.unref?.();
  }
}

/** Exposed for tests: flush synchronously-awaitable and reset state. */
export async function __flushLiveEventsForTest(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await flush();
}

const WATCHED_UIDS = new Set([
  "api::comment.comment",
  "api::reaction.reaction",
  "api::notification.notification",
  "api::announcement.announcement",
]);

function relationId(value: unknown): number | null {
  // Relation values arrive in several shapes depending on the write path:
  // a scalar id, { id }, or the { set: [{ id }] } form (see wiki-page
  // lifecycle fix 4cfb429).
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    const v = value as any;
    if (typeof v.id === "number") return v.id;
    if (Array.isArray(v.set) && typeof v.set[0]?.id === "number") return v.set[0].id;
    if (Array.isArray(v.connect) && typeof v.connect[0]?.id === "number") return v.connect[0].id;
  }
  return null;
}

/**
 * Global DB-lifecycle subscriber — the one chokepoint that sees every
 * write path, including the `strapi.db.query` bypasses (reaction
 * toggle-off delete, notification creates from lifecycles). Registered
 * from bootstrap (see src/index.ts). Must never throw into a write.
 */
export function registerLiveEventSubscriber(strapi: any): void {
  strapi.db.lifecycles.subscribe(async (event: any) => {
    try {
      const uid: string | undefined = event?.model?.uid;
      if (!uid || !WATCHED_UIDS.has(uid)) return;
      if (!liveEventsEnabled()) return;

      const action: string = event.action;
      const row = event.result ?? {};

      if (uid === "api::comment.comment" || uid === "api::reaction.reaction") {
        if (action !== "afterCreate" && action !== "afterDelete" && action !== "afterUpdate")
          return;
        const targetType = row.targetType ?? event.params?.data?.targetType;
        const targetDocumentId = row.targetDocumentId ?? event.params?.data?.targetDocumentId;
        // deleteMany / rows without an anchor: nothing to address a channel
        // with — the polling backstop covers these rare paths.
        if (typeof targetType !== "string" || typeof targetDocumentId !== "string") return;
        emitLiveEvent({ kind: "content", targetType, targetDocumentId });
        return;
      }

      if (uid === "api::notification.notification") {
        // Only fan-out creates here. markRead/markAllRead run updateMany
        // (afterUpdateMany carries no rows) — those emit straight from the
        // notification controller, which knows ctx.state.user.
        if (action !== "afterCreate") return;
        let recipientId = relationId(event.params?.data?.recipient) ?? relationId(row.recipient);
        if (recipientId == null && row.id != null) {
          // Link-table caveat: the result row does not populate relations
          // (same reason the comment lifecycle re-reads its row).
          const full = await strapi.db.query("api::notification.notification").findOne({
            where: { id: row.id },
            populate: { recipient: true },
          });
          recipientId = full?.recipient?.id ?? null;
        }
        if (recipientId != null) emitLiveEvent({ kind: "notification", recipientId });
        return;
      }

      if (uid === "api::announcement.announcement") {
        // Publish cycle in Strapi 5 is delete+recreate: only a create of a
        // *published* row signals "the list changed"; deletes are ignored
        // entirely to avoid phantom events on every re-publish.
        if (action !== "afterCreate") return;
        if (!row.publishedAt) return;
        emitLiveEvent({ kind: "announcements" });
      }
    } catch (err) {
      strapi.log?.warn?.(`[live-emit] subscriber error: ${(err as Error).message}`);
    }
  });
  strapi.log?.info?.("[live-emit] DB lifecycle subscriber registered");
}
