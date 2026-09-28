/**
 * Pure event-RSVP rules (FX21), shared by the event-rsvp controller's
 * upsert, capacity gate and read filter. No Strapi runtime: every function
 * takes rows as `strapi.db.query` returns them (the `user` relation
 * populated, or null when the user is gone).
 *
 * The accepted check-then-insert race: two concurrent first answers can
 * insert two rows for the same (user, event), and two concurrent "yes"
 * switches can overshoot a capacity by one (poll-vote precedent; no unique
 * DB constraint spans the user link table). Every rule here therefore works
 * on DISTINCT users, and the newest row of a user is the answer that
 * counts; the next upsert heals the duplicates (pickSurvivor's order).
 */

import { isDocumentId } from "./entry-id";

export const RSVP_STATUSES = ["yes", "no", "maybe"] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

export function isRsvpStatus(value: unknown): value is RsvpStatus {
  return typeof value === "string" && (RSVP_STATUSES as readonly string[]).includes(value);
}

/** An RSVP row as `strapi.db.query` returns it, with `user` populated. */
export interface RsvpRow {
  id: number;
  status?: unknown;
  respondedAt?: string | Date | null;
  targetDocumentId?: unknown;
  user?: { id?: unknown; displayName?: unknown } | null;
}

/** A caller as users-permissions puts it on ctx.state.user. */
export interface RsvpCaller {
  id?: unknown;
  role?: { type?: unknown } | null;
}

function respondedTime(row: RsvpRow): number {
  if (!row.respondedAt) return 0;
  const time = new Date(row.respondedAt).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/** Newest first: respondedAt descending (none = oldest), then id descending. */
export function compareNewestFirst(a: RsvpRow, b: RsvpRow): number {
  return respondedTime(b) - respondedTime(a) || b.id - a.id;
}

/** A copy of one user's rows for one event, newest (the survivor) first. */
export function newestFirst<T extends RsvpRow>(rows: readonly T[]): T[] {
  return [...rows].sort(compareNewestFirst);
}

/**
 * The row that counts among one user's rows for one event: the newest by
 * respondedAt, then id. The upsert keeps exactly this row and deletes the
 * others (healing), and every aggregate reads only this row per user.
 */
export function pickSurvivor<T extends RsvpRow>(rows: readonly T[]): T | null {
  return newestFirst(rows)[0] ?? null;
}

/** The numeric user id of a row, or null when the user is gone. */
export function rowUserId(row: RsvpRow): number | null {
  const id = row.user?.id;
  return typeof id === "number" ? id : null;
}

/**
 * How many users hold a seat: users whose answer, the newest of their rows
 * (pickSurvivor), is "yes", not counting `excludeUserId` (the caller: their
 * own switch to "yes" must not count against them). Takes an event's rows
 * of EVERY status. This is the rule summarizeRsvps counts by, so the gate
 * and the numbers the events page shows agree: a user's duplicate rows from
 * the race above count once, and an older "yes" row keeps no seat once a
 * newer row says "no" or "maybe". A row without a user (the user was
 * deleted) holds no seat.
 */
export function seatHolders(rows: readonly RsvpRow[], excludeUserId?: number | null): number {
  const byUser = new Map<number, RsvpRow[]>();
  for (const row of rows) {
    const id = rowUserId(row);
    if (id === null || id === excludeUserId) continue;
    const list = byUser.get(id);
    if (list) list.push(row);
    else byUser.set(id, [row]);
  }
  let seats = 0;
  for (const list of byUser.values()) {
    if (pickSurvivor(list)?.status === "yes") seats += 1;
  }
  return seats;
}

/**
 * The capacity gate for a transition INTO "yes": "full" when the event has
 * a positive integer capacity and at least that many other users hold a
 * seat (seatHolders). No (or a non-positive, non-integer) capacity means no
 * limit.
 */
export function capacityDecision(capacity: unknown, yesUsers: number): "open" | "full" {
  if (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity <= 0) {
    return "open";
  }
  return yesUsers >= capacity ? "full" : "open";
}

/**
 * Read privacy: attendance ("yes") is public inside the intranet, but WHO
 * declined or is unsure is not. Deletes the `user` relation from every row
 * that is neither status=yes nor the caller's own answer, in place;
 * admin_role sees everything. maybe/no stay countable, the names of
 * decliners do not leak.
 */
export function stripPrivateUsers(rows: unknown[], caller: RsvpCaller | null | undefined): void {
  if (caller?.role?.type === "admin_role") return;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as { status?: unknown; user?: { id?: unknown } | null };
    if (record.status === "yes") continue;
    if (caller && record.user?.id === caller.id) continue;
    delete record.user;
  }
}

// ---------------------------------------------------------------------------
// Raw reads: GET /api/event-rsvps and /api/event-rsvps/:id (FX21)
// ---------------------------------------------------------------------------

/**
 * Whether a client `filters` tree names the `user` relation anywhere: at
 * the root, inside $and/$or/$not, in list form or in the object form qs
 * produces for long lists. The raw reads refuse such a filter for every
 * role but admin_role (policies/event-rsvp-own-rows.ts): on the caller's
 * own rows it has no use, so the read guard accepts none. Walks
 * iteratively and visits each object once (a parsed query is a tree, but
 * a hand-built one need not be).
 */
export function filtersReferenceUser(filters: unknown): boolean {
  const pending: unknown[] = [filters];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      pending.push(...node);
      continue;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "user" || key.startsWith("user.")) return true;
      pending.push(value);
    }
  }
  return false;
}

/**
 * Whether the request asks for the Strapi v4 response shape (the
 * `Strapi-Response-Format` header). @strapi/core 5.55.1 switches to
 * `{ id, attributes: {...} }` for the value "v4" (core-api/controller
 * transformResponse); the raw reads refuse the header outright for every
 * role but admin_role, so no response shape other than the one the
 * privacy filter was written for can ever be served. Koa lowercases
 * header names.
 */
export function requestsLegacyFormat(headers: unknown): boolean {
  if (headers === null || typeof headers !== "object") return false;
  const value = (headers as Record<string, unknown>)["strapi-response-format"];
  if (Array.isArray(value)) return value.some((item) => String(item).trim() !== "");
  return value !== undefined && value !== null && String(value).trim() !== "";
}

// ---------------------------------------------------------------------------
// The summary endpoint: GET /api/event-rsvps/summary?targets=<documentIds>
// ---------------------------------------------------------------------------

/** Most events one summary request may name (the events list shows at most 50). */
export const MAX_SUMMARY_TARGETS = 50;

/**
 * The `targets` query parameter: event documentIds, comma-separated
 * (`targets=a,b`) or repeated (`targets[0]=a&targets[1]=b`). Duplicates
 * collapse, the order is kept. Anything but documentId-shaped strings, no
 * target at all, or more than MAX_SUMMARY_TARGETS distinct ones is an
 * error: the endpoint answers it with 400 before any query.
 */
export function parseSummaryTargets(raw: unknown): { targets: string[] } | { error: string } {
  const parts: unknown[] =
    typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const targets: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") return { error: "Invalid targets" };
    for (const id of part.split(",")) {
      if (!isDocumentId(id)) return { error: "Invalid targets" };
      if (!targets.includes(id)) targets.push(id);
    }
  }
  if (targets.length === 0) return { error: "targets required" };
  if (targets.length > MAX_SUMMARY_TARGETS) {
    return { error: `At most ${MAX_SUMMARY_TARGETS} targets` };
  }
  return { targets };
}

/** One event's aggregate, as the summary endpoint returns it. */
export interface RsvpSummary {
  targetDocumentId: string;
  yesCount: number;
  maybeCount: number;
  noCount: number;
  /** Display names of the "yes" answers, oldest answer first (attendance is public). */
  yesNames: string[];
  /** The caller's own answer, if any. */
  myStatus: RsvpStatus | null;
}

/**
 * One summary per target, in the order given, computed from every RSVP row
 * of those targets. Only the survivor of each (event, user) counts
 * (pickSurvivor), so duplicate rows never inflate a bucket; a row whose
 * user is gone counts on its own. The only names that leave the CMS are
 * those of "yes" answers with a display name: who answered maybe or no
 * stays private (as stripPrivateUsers keeps it for the raw reads), and the
 * caller learns only their own answer (myStatus).
 */
export function summarizeRsvps(
  rows: readonly RsvpRow[],
  targets: readonly string[],
  callerId: number | null,
): RsvpSummary[] {
  const byTarget = new Map<string, RsvpSummary>();
  for (const targetDocumentId of targets) {
    byTarget.set(targetDocumentId, {
      targetDocumentId,
      yesCount: 0,
      maybeCount: 0,
      noCount: 0,
      yesNames: [],
      myStatus: null,
    });
  }

  const answers = new Map<string, RsvpRow[]>();
  for (const row of rows) {
    const target = row.targetDocumentId;
    if (typeof target !== "string" || !byTarget.has(target)) continue;
    const userId = rowUserId(row);
    const key = `${target}\u0000${userId ?? `row-${row.id}`}`;
    const list = answers.get(key);
    if (list) list.push(row);
    else answers.set(key, [row]);
  }

  // Oldest answer first, so the yes names read in answer order.
  const survivors = [...answers.values()]
    .map((list) => pickSurvivor(list))
    .filter((row): row is RsvpRow => row !== null)
    .sort((a, b) => compareNewestFirst(b, a));
  for (const row of survivors) {
    const summary = byTarget.get(row.targetDocumentId as string);
    if (!summary || !isRsvpStatus(row.status)) continue;
    if (row.status === "yes") {
      summary.yesCount += 1;
      const name = row.user?.displayName;
      if (typeof name === "string" && name !== "") summary.yesNames.push(name);
    } else if (row.status === "maybe") summary.maybeCount += 1;
    else summary.noCount += 1;
    if (callerId !== null && rowUserId(row) === callerId) summary.myStatus = row.status;
  }
  return targets.map((target) => byTarget.get(target) as RsvpSummary);
}
