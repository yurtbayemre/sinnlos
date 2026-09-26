/**
 * The poll close rule (datetime contract, deep-dive decision 04, C7): a poll
 * is closed iff now >= closesAt. One rule for the cms vote handler and the
 * web (apps/web/src/lib/poll-close.ts, same semantics); before, the cms
 * accepted a vote at the exact closing instant while the web already listed
 * the poll as closed.
 *
 * closesAt is an instant. The web form's "closes on D" stores
 * D 23:59:59 in APP_TIME_ZONE. No closesAt means the poll never closes; an
 * unparseable value counts as open, as before (Strapi only stores valid
 * datetimes).
 */
import { instantMsOrNull, type InstantInput } from "./time";

export function isPollClosed(closesAt: InstantInput | null | undefined, now: Date = new Date()): boolean {
  const closesAtMs = instantMsOrNull(closesAt);
  if (closesAtMs === null) return false;
  return now.getTime() >= closesAtMs;
}
