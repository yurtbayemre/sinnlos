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
 *
 * The body is the tab's FULL desired set with a revision (LF05,
 * LiveSubscribeRequest in the live contract): `{ connId, rev, channels }`,
 * at most MAX_SUBSCRIBE_LIST channels per POST, a bigger set in several
 * POSTs of the same rev. The bus ignores a stale revision and caps a
 * connection at 200 channels; the answer says what happened:
 * `{ ok, applied, rev, channels, dropped }` (applied false = stale, `rev`
 * then is the connection's newer one). The add/remove body of the previous
 * client is still accepted for tabs that run the old bundle after a
 * deploy (live-bus.ts subscribe()).
 */
import { getSession } from "@/lib/session";

import { getLiveBus, liveEventsDisabled } from "@/lib/live-bus";
import {
  MAX_SUBSCRIBE_LIST,
  isContentChannel,
  parseSubscribeRequest,
  type ContentChannel,
} from "@/lib/live-contract";

export const dynamic = "force-dynamic";

/**
 * A list of content channels ("<targetType>:<targetDocumentId>", the comment
 * target types; lib/live-contract.ts) of the old add/remove body. The global
 * channels need no subscription and are refused like any other malformed
 * entry.
 */
function parseChannels(value: unknown): ContentChannel[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SUBSCRIBE_LIST) return null;
  const out: ContentChannel[] = [];
  for (const ch of value) {
    if (!isContentChannel(ch)) return null;
    out.push(ch);
  }
  return out;
}

const invalid = () => Response.json({ error: "invalid payload" }, { status: 400 });
// Unknown/foreign connId: the stream was evicted, rotated or never ours.
// 404 tells the client to resync subscriptions after its next hello.
const unknownConnection = () => Response.json({ error: "unknown connection" }, { status: 404 });

export async function POST(req: Request) {
  const session = await getSession();
  const userId = session?.user && "id" in session.user ? session.user.id : undefined;
  if (typeof userId !== "number") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (liveEventsDisabled()) {
    return Response.json({ error: "live events disabled" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body && typeof body === "object" && ("rev" in body || "channels" in body)) {
    const request = parseSubscribeRequest(body);
    if (!request) return invalid();
    const result = getLiveBus().sync(request.connId, userId, request.rev, request.channels);
    if (result.status === "unknown") return unknownConnection();
    if (result.status === "stale") {
      return Response.json({ ok: true, applied: false, rev: result.rev });
    }
    return Response.json({
      ok: true,
      applied: true,
      rev: result.rev,
      channels: result.channels,
      dropped: result.dropped,
    });
  }

  // The previous client's add/remove body.
  const connId = typeof body?.connId === "string" ? body.connId : null;
  const add = parseChannels(body?.add);
  const remove = parseChannels(body?.remove);
  if (!connId || !add || !remove) return invalid();
  if (!getLiveBus().subscribe(connId, userId, add, remove)) return unknownConnection();
  return Response.json({ ok: true });
}
