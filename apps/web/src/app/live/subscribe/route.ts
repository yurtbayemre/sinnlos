/**
 * Channel subscription endpoint for the live SSE bus. Comment/reaction
 * pings are delivered subscription-based, NOT broadcast: documentIds
 * act as capability tokens in this repo (docs/architecture.md §5.17),
 * so handing every connection all changed ids would leak the existence
 * of restricted discussions. A tab may only subscribe to channels whose
 * ids the policy-filtered pages already served it; a guessed id yields
 * pings but the follow-up refetch returns nothing the caller couldn't
 * already query directly — today's posture, unchanged.
 *
 * Ownership: the connId from the stream's `hello` frame is bound to the
 * session userId in the bus; subscribing to a foreign connId fails.
 */
import { auth } from "@/auth";

import { getLiveBus, liveEventsDisabled } from "@/lib/live-bus";

export const dynamic = "force-dynamic";

/** `${targetType}:${targetDocumentId}` — target types from comment-target.ts. */
const CHANNEL_RE = /^(announcement|wiki-page):[A-Za-z0-9_-]{1,64}$/;
const MAX_LIST = 100;

function parseChannels(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST) return null;
  const out: string[] = [];
  for (const ch of value) {
    if (typeof ch !== "string" || !CHANNEL_RE.test(ch)) return null;
    out.push(ch);
  }
  return out;
}

export async function POST(req: Request) {
  const session = await auth();
  const userId = session?.user && "id" in session.user ? session.user.id : undefined;
  if (typeof userId !== "number") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (liveEventsDisabled()) {
    return Response.json({ error: "live events disabled" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as {
    connId?: unknown;
    add?: unknown;
    remove?: unknown;
  } | null;
  const connId = typeof body?.connId === "string" ? body.connId : null;
  const add = parseChannels(body?.add);
  const remove = parseChannels(body?.remove);
  if (!connId || !add || !remove) {
    return Response.json({ error: "invalid payload" }, { status: 400 });
  }

  const ok = getLiveBus().subscribe(connId, userId, add, remove);
  // Unknown/foreign connId: the stream was evicted, rotated or never ours.
  // 404 tells the provider to resync subscriptions after its next hello.
  if (!ok) return Response.json({ error: "unknown connection" }, { status: 404 });
  return Response.json({ ok: true });
}
