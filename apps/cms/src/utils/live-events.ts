/**
 * Fire-and-forget push of *content-free* change pings to the Next.js
 * live-event bus (`/api/live/emit`), which fans them out to open SSE
 * streams. Clients react by refetching through their own session/JWT,
 * so every visibility policy applies by construction — these events
 * carry no content, only "something on channel X changed".
 *
 * WEB_INTERNAL_URL + REVALIDATE_SECRET (sent as x-revalidate-secret) now
 * serve only this ingest: D-DC01 removed the cache-revalidation webhook
 * that once shared them, and the names are kept for compatibility.
 * Non-2xx responses are logged: the whole pipeline is fire-and-forget, so
 * a silently failing emit would present as a perfectly healthy app that
 * just never updates (see issue #17 plan).
 *
 * Events are micro-batched (100ms) and deduped per channel: a single
 * announcement publish fans out to N notification rows, and the seed /
 * bulk paths fire the DB lifecycle subscriber too — without batching
 * that would be N POSTs instead of one. A batch goes out in POSTs of at
 * most MAX_EVENTS_PER_EMIT (1000) events, one after the other: the web
 * refuses a longer list as malformed (400), which lost the whole burst,
 * notifications included (LF01).
 *
 * Event shapes and channel names come from the live contract
 * (./live-contract.ts, from @sinnlos/domain like the web's
 * lib/live-contract.ts, LF04). A content event whose target has no valid channel is dropped here:
 * no connection can subscribe to it.
 *
 * Post-commit (LF02): the DB subscriber runs inside the write's
 * transaction, so it queues a ping only once that transaction commits
 * (utils/after-commit.ts); a rollback pings nothing, and a client that
 * refetches on the ping sees the committed rows. Outside a transaction it
 * pings right away. emitLiveEvent itself queues immediately: the
 * controllers call it after their writes returned.
 */
import { afterCommit, type CommitAwareDb } from "./after-commit";
import { MAX_EVENTS_PER_EMIT, channelFor, type LiveEvent } from "./live-contract";

export type { LiveEvent } from "./live-contract";

const BATCH_WINDOW_MS = 100;

let pending = new Map<string, LiveEvent>();
let timer: NodeJS.Timeout | null = null;

function dedupeKey(event: LiveEvent): string {
  switch (event.kind) {
    case "content":
      return `c:${channelFor(event)}`;
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

/** POSTs one chunk of at most MAX_EVENTS_PER_EMIT events; never throws. */
async function post(webUrl: string, secret: string, events: LiveEvent[]): Promise<void> {
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
      console.warn(
        `[live-emit] status=${res.status} for ${events.length} event(s) — live pings are NOT reaching the web bus`,
      );
    }
  } catch (err) {
    console.warn(`[live-emit] failed (${events.length} event(s)): ${(err as Error).message}`);
  }
}

async function flush(): Promise<void> {
  timer = null;
  if (pending.size === 0) return;
  const events = [...pending.values()];
  pending = new Map();

  const webUrl = process.env.WEB_INTERNAL_URL;
  const secret = process.env.REVALIDATE_SECRET;
  if (!webUrl || !secret) return;

  const chunks = Math.ceil(events.length / MAX_EVENTS_PER_EMIT);
  if (chunks > 1) {
    console.info(
      `[live-emit] ${events.length} events in ${chunks} POSTs (at most ${MAX_EVENTS_PER_EMIT} each)`,
    );
  }
  // One after the other, in queue order: a burst never opens more than one
  // request to the web at a time, and a failed chunk does not stop the rest.
  for (let start = 0; start < events.length; start += MAX_EVENTS_PER_EMIT) {
    await post(webUrl, secret, events.slice(start, start + MAX_EVENTS_PER_EMIT));
  }
}

/**
 * Queue a live event. Never throws, never blocks the caller's write
 * transaction (the actual POST happens on a detached timer).
 */
export function emitLiveEvent(event: LiveEvent): void {
  if (!liveEventsEnabled()) return;
  if (event.kind === "content" && channelFor(event) === null) return;
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
  // lifecycle fix a195dca).
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    const v = value as { id?: unknown; set?: { id?: unknown }[]; connect?: { id?: unknown }[] };
    if (typeof v.id === "number") return v.id;
    if (Array.isArray(v.set) && typeof v.set[0]?.id === "number") return v.set[0].id;
    if (Array.isArray(v.connect) && typeof v.connect[0]?.id === "number") return v.connect[0].id;
  }
  return null;
}

/** A DB lifecycle event as @strapi/database hands it to a subscriber (the parts read here). */
export interface LiveLifecycleEvent {
  action?: string;
  model?: { uid?: string } | null;
  result?: Record<string, unknown> | null;
  params?: { data?: Record<string, unknown> | null } | null;
}

/** One lifecycle action handler of the subscriber. */
export type LiveHandler = (event: LiveLifecycleEvent) => Promise<void>;

/** The object-form subscriber: only `models`, only these actions (LF06). */
export type LiveSubscriber = {
  models: string[];
  afterCreate: LiveHandler;
  afterUpdate: LiveHandler;
  afterDelete: LiveHandler;
};

/** The slice of the Strapi instance the subscriber needs. */
export interface LiveSubscriberStrapi {
  db: CommitAwareDb & {
    lifecycles: { subscribe(subscriber: LiveSubscriber): unknown };
    query(uid: string): { findOne(params: Record<string, unknown>): Promise<unknown> };
  };
  log?: { info?(message: string): void; warn?(message: string): void };
}

/**
 * Global DB-lifecycle subscriber — the one chokepoint that sees every
 * write path, including the `strapi.db.query` bypasses (reaction
 * toggle-off delete, notification creates from lifecycles). Registered
 * from bootstrap (see src/index.ts). Must never throw into a write.
 * Pings go out after the write's transaction commits (LF02).
 */
export function registerLiveEventSubscriber(strapi: LiveSubscriberStrapi): void {
  const emit = (event: LiveEvent) =>
    afterCommit(
      strapi.db,
      () => emitLiveEvent(event),
      (err) =>
        strapi.log?.warn?.(`[live-emit] post-commit ping failed: ${(err as Error)?.message}`),
    );

  const handle: LiveHandler = async (event) => {
    try {
      const uid = event?.model?.uid;
      if (!uid || !WATCHED_UIDS.has(uid)) return;
      if (!liveEventsEnabled()) return;

      const action = event.action;
      const row: Record<string, unknown> = event.result ?? {};
      const data: Record<string, unknown> = event.params?.data ?? {};

      if (uid === "api::comment.comment" || uid === "api::reaction.reaction") {
        if (action !== "afterCreate" && action !== "afterDelete" && action !== "afterUpdate")
          return;
        const targetType = row.targetType ?? data.targetType;
        const targetDocumentId = row.targetDocumentId ?? data.targetDocumentId;
        // deleteMany / rows without an anchor: nothing to address a channel
        // with — the polling backstop covers these rare paths.
        if (typeof targetType !== "string" || typeof targetDocumentId !== "string") return;
        await emit({ kind: "content", targetType, targetDocumentId });
        return;
      }

      if (uid === "api::notification.notification") {
        // Only fan-out creates here. markRead/markAllRead run updateMany
        // (afterUpdateMany carries no rows) — those emit straight from the
        // notification controller, which knows ctx.state.user.
        if (action !== "afterCreate") return;
        let recipientId = relationId(data.recipient) ?? relationId(row.recipient);
        if (recipientId == null && row.id != null) {
          // Link-table caveat: the result row does not populate relations
          // (same reason the comment lifecycle re-reads its row).
          const full = (await strapi.db.query("api::notification.notification").findOne({
            where: { id: row.id },
            populate: { recipient: true },
          })) as { recipient?: { id?: number } | null } | null;
          recipientId = full?.recipient?.id ?? null;
        }
        if (recipientId != null) await emit({ kind: "notification", recipientId });
        return;
      }

      if (uid === "api::announcement.announcement") {
        // Publish cycle in Strapi 5 is delete+recreate: only a create of a
        // *published* row signals "the list changed"; deletes are ignored
        // entirely to avoid phantom events on every re-publish.
        if (action !== "afterCreate") return;
        if (!row.publishedAt) return;
        await emit({ kind: "announcements" });
      }
    } catch (err) {
      strapi.log?.warn?.(`[live-emit] subscriber error: ${(err as Error).message}`);
    }
  };

  // Object form (LF06): @strapi/database calls it only for these models and
  // actions, instead of for every action of every model as a function
  // subscriber (lifecycles/index.js run).
  strapi.db.lifecycles.subscribe({
    models: [...WATCHED_UIDS],
    afterCreate: handle,
    afterUpdate: handle,
    afterDelete: handle,
  });
  strapi.log?.info?.("[live-emit] DB lifecycle subscriber registered");
}
