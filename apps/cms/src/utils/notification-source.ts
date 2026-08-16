/**
 * Notification source anchors + fan-out dedup — the single source of truth
 * for "which members of this audience have already been notified about this
 * source document?".
 *
 * Why this exists (GitHub issue #12): announcement and event are
 * draftAndPublish types, and Strapi 5 publishes by DELETE-then-RECREATE
 * (documents-service publish path). Every re-publish therefore fires the
 * `afterCreate` lifecycle again with `publishedAt` set, and the notification
 * fan-out ran a second, third, … time — the whole audience got the same
 * "New announcement: …" over and over. An earlier `beforeUpdate` guard aimed
 * at the update path and never saw the real trigger, so it was removed.
 *
 * The fix needs a reference from the notification back to its source, which
 * the schema did not have (type/title/link only). Notifications now carry
 * `sourceType` + `sourceDocumentId`.
 *
 * `sourceDocumentId` is the **documentId**, never the numeric row id: the
 * row id of a published entry changes on every publish (delete+recreate), so
 * an id-anchored dedup would never match — exactly the trap documented in
 * docs/architecture.md §5.17 (acknowledgement / event-rsvp anchor the same
 * way; comment/reaction still don't — issue #11).
 *
 * GRANULARITY IS THE RECIPIENT, NOT THE SOURCE. The first cut of #12 counted
 * the rows for (sourceType, sourceDocumentId) and skipped the whole fan-out
 * at ≥1. That over-blocked in two ways:
 *   - Retargeting: publish to department A, correct the announcement to
 *     department B, publish again → B was never notified and only a manual
 *     DB edit could recover. Now the audience is diffed against the users who
 *     already hold a notification for this anchor, so B gets it and A is not
 *     notified twice.
 *   - A fan-out that dies half-way (k of n rows written) used to leave the
 *     source permanently "done". Per recipient this is SELF-HEALING: the next
 *     publish sees the k written rows and delivers exactly the missing n−k.
 *     That self-healing is why the fan-out needs no transaction bracket — a
 *     partial write is a recoverable state, not a corrupt one.
 *
 * Known limit, unchanged and accepted: this is check-then-insert, so two
 * publishes racing each other can both read the same "already notified" set
 * and both write. Duplicates are then a genuine photo-finish artefact instead
 * of the systematic re-notify #12 was about. No DB unique index is possible —
 * `recipient` is a link-table relation, exactly the constraint already
 * documented for ack/rsvp/poll-vote in §7b (issue #16).
 *
 * Pure decision logic, no Strapi runtime, so the dedup itself is unit
 * testable (`notification-source.test.ts`); `resolveFanout` is the thin
 * runtime wrapper the two lifecycles call.
 */

/** Content types whose publish triggers an audience-wide fan-out. */
export type NotificationSourceType = "announcement" | "event";

/** The stable back-reference stored on every fan-out notification. */
export interface SourceAnchor {
  sourceType: NotificationSourceType;
  /** documentId of the source row — NOT its numeric id (§5.17). */
  sourceDocumentId: string;
}

/** Whatever a lifecycle hands us: `event.result` or a db.query row. */
export interface SourceRow {
  id?: number | string | null;
  documentId?: string | null;
}

/**
 * Build the anchor for a source row. Returns `null` when the row carries no
 * usable documentId — every Strapi 5 entry has one, but a lifecycle result
 * that somehow lacks it must not silently produce un-anchored rows that look
 * like a valid dedup key.
 */
export function sourceAnchor(
  sourceType: NotificationSourceType,
  row: SourceRow | null | undefined,
): SourceAnchor | null {
  const documentId = typeof row?.documentId === "string" ? row.documentId.trim() : "";
  if (!documentId) return null;
  return { sourceType, sourceDocumentId: documentId };
}

/** `where` filter selecting every notification created for one source. */
export function sourceFilter(anchor: SourceAnchor): {
  sourceType: NotificationSourceType;
  sourceDocumentId: string;
} {
  return { sourceType: anchor.sourceType, sourceDocumentId: anchor.sourceDocumentId };
}

/**
 * Normalise an id to a comparison key. User ids arrive as numbers from the
 * db layer but as strings often enough (query params, populated payloads)
 * that comparing raw values would silently miss matches. `null` means "no
 * usable id" — the caller decides what that implies (always: fail open).
 */
function idKey(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  return null;
}

/** One row of the "who already got this?" lookup. */
export interface NotifiedNotificationRow {
  recipient?: { id?: number | string | null } | null;
}

/**
 * Turn the lookup result into the set of user ids that already hold a
 * notification for the anchor.
 *
 * Returns `null` when the result is unusable (not an array — a failed or
 * mocked-away query). `null` is the fail-open signal: it means "we do not
 * know who was notified", never "nobody was notified".
 *
 * Rows without a populated recipient are dropped: they cannot suppress
 * anybody. That covers the pre-#12 rows too, which additionally carry no
 * anchor and are therefore already outside the `where` filter.
 */
export function notifiedRecipientIds(rows: unknown): Set<string> | null {
  if (!Array.isArray(rows)) return null;
  const ids = new Set<string>();
  for (const row of rows as NotifiedNotificationRow[]) {
    const key = idKey(row?.recipient?.id);
    if (key != null) ids.add(key);
  }
  return ids;
}

export type FanoutReason =
  /** Anchored, and nobody in the audience has been notified yet. */
  | "first-publish"
  /** Anchored, some of the audience is new (retarget or resumed fan-out). */
  | "partial-fanout"
  /** Anchored, every current recipient already holds a notification. */
  | "already-notified"
  /** Nobody to notify — audience is empty (author-only, empty department, …). */
  | "empty-audience"
  /** Source without documentId: dedup impossible → notify all, fail-open. */
  | "no-anchor"
  /** Lookup of the already-notified set failed → notify all, fail-open. */
  | "lookup-failed";

export interface FanoutPlan<T> {
  /** The audience members that still need a notification. */
  recipients: T[];
  /** Size of the audience handed in (before the dedup). */
  audienceSize: number;
  /** How many of them already hold a notification for this anchor. */
  alreadyNotified: number;
  reason: FanoutReason;
}

/**
 * The dedup decision: audience minus the users already notified for this
 * source.
 *
 * `alreadyNotified` is the set from `notifiedRecipientIds` (any iterable of
 * ids works); `null`/`undefined` means the lookup produced nothing usable.
 *
 * Fail-open on purpose: only ids we positively know about suppress a
 * recipient. No anchor, a failed lookup, or an audience member without a
 * usable id all keep the previous behaviour (notify) rather than silently
 * dropping notifications — a duplicate is annoying, a missing announcement
 * notification is a broken feature.
 *
 * Legacy rows (created before the anchor fields existed) have NULL in both
 * anchor columns, never match the `where` filter, and are invisible here —
 * see the note in the lifecycles.
 */
export function planFanout<T>(
  anchor: SourceAnchor | null,
  alreadyNotified: Iterable<unknown> | null | undefined,
  audience: readonly T[] | null | undefined,
  recipientId: (member: T) => unknown,
): FanoutPlan<T> {
  const members = Array.isArray(audience) ? [...audience] : [];

  if (anchor == null) {
    return {
      recipients: members,
      audienceSize: members.length,
      alreadyNotified: 0,
      reason: "no-anchor",
    };
  }
  if (alreadyNotified == null) {
    return {
      recipients: members,
      audienceSize: members.length,
      alreadyNotified: 0,
      reason: "lookup-failed",
    };
  }
  if (members.length === 0) {
    return { recipients: [], audienceSize: 0, alreadyNotified: 0, reason: "empty-audience" };
  }

  const notifiedKeys = new Set<string>();
  for (const id of alreadyNotified) {
    const key = idKey(id);
    if (key != null) notifiedKeys.add(key);
  }

  const recipients = members.filter((member) => {
    const key = idKey(recipientId(member));
    // Unusable id → cannot prove they were notified → notify (fail open).
    return key == null || !notifiedKeys.has(key);
  });
  const alreadyNotifiedCount = members.length - recipients.length;

  let reason: FanoutReason = "first-publish";
  if (recipients.length === 0) reason = "already-notified";
  else if (alreadyNotifiedCount > 0) reason = "partial-fanout";

  return {
    recipients,
    audienceSize: members.length,
    alreadyNotified: alreadyNotifiedCount,
    reason,
  };
}

/** Minimal slice of the Strapi instance this helper needs. */
export interface FanoutStrapi {
  db: {
    query: (uid: string) => {
      findMany: (params: {
        where: Record<string, unknown>;
        populate: Record<string, unknown>;
      }) => Promise<unknown>;
    };
  };
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}

/**
 * Runtime wrapper for the lifecycles: resolve the anchor, load who already
 * holds a notification for it, and hand back only the audience members that
 * still need one — plus a log line saying how many were skipped and why
 * (otherwise a deduped re-publish looks like a silent failure in the logs).
 *
 * ONE query (`findMany` over the two anchor columns, recipient id populated)
 * and it runs after the audience is built, because the dedup now needs the
 * audience to diff against.
 */
export async function resolveFanout<T>(
  strapiInstance: FanoutStrapi,
  sourceType: NotificationSourceType,
  row: SourceRow | null | undefined,
  audience: readonly T[] | null | undefined,
  recipientId: (member: T) => unknown,
): Promise<{ recipients: T[]; anchor: SourceAnchor | null }> {
  const anchor = sourceAnchor(sourceType, row);

  let alreadyNotified: Set<string> | null = null;
  let lookupError: string | null = null;
  if (anchor) {
    try {
      const notifications = await strapiInstance.db
        .query("api::notification.notification")
        .findMany({ where: sourceFilter(anchor), populate: { recipient: { select: ["id"] } } });
      alreadyNotified = notifiedRecipientIds(notifications);
      if (alreadyNotified == null) lookupError = "lookup returned no usable rows";
    } catch (err) {
      alreadyNotified = null;
      lookupError = (err as Error)?.message ?? "unknown error";
    }
  }

  const plan = planFanout(anchor, alreadyNotified, audience, recipientId);

  if (plan.reason === "no-anchor") {
    strapiInstance.log?.warn?.(
      `[notifications] ${sourceType} #${row?.id ?? "?"} has no documentId — ` +
        `notifying ${plan.recipients.length} recipient(s) without dedup, ` +
        `a re-publish would notify them again`,
    );
  } else if (plan.reason === "lookup-failed") {
    strapiInstance.log?.warn?.(
      `[notifications] could not load the already-notified recipients of ${sourceType} ` +
        `${anchor?.sourceDocumentId} (${lookupError}) — notifying all ` +
        `${plan.recipients.length} recipient(s) rather than none (fail-open)`,
    );
  } else if (plan.alreadyNotified > 0) {
    strapiInstance.log?.info?.(
      `[notifications] ${sourceType} ${anchor?.sourceDocumentId}: ` +
        `${plan.alreadyNotified} of ${plan.audienceSize} recipient(s) already notified, ` +
        `${plan.recipients.length} new` +
        (plan.recipients.length === 0
          ? " — re-publish without audience change, nothing to send (issue #12 dedup)"
          : " (issue #12 dedup)"),
    );
  }

  return { recipients: plan.recipients, anchor };
}
