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
 * How many DISTINCT users have a "yes" row, not counting `excludeUserId`
 * (the caller: their own switch to "yes" must not count against them).
 * Distinct users, not rows: duplicates from the race above would overstate
 * the occupancy. A row without a user (the user was deleted) holds no seat.
 */
export function distinctYesUsers(rows: readonly RsvpRow[], excludeUserId?: number | null): number {
  const userIds = new Set<number>();
  for (const row of rows) {
    if (row.status !== "yes") continue;
    const id = rowUserId(row);
    if (id !== null && id !== excludeUserId) userIds.add(id);
  }
  return userIds.size;
}

/**
 * The capacity gate for a transition INTO "yes": "full" when the event has
 * a positive integer capacity and at least that many other distinct users
 * already answered "yes". No (or a non-positive, non-integer) capacity
 * means no limit.
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
