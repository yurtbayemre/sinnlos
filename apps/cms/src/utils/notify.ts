/**
 * The one notification writer (roadmap FX18): every lifecycle that notifies
 * builds its rows here, so titles, fallbacks, the create() rule and the log
 * lines are the same everywhere.
 *
 *  - buildNotification: the row for ONE recipient. The title is assembled
 *    from parts (fixed text and values with a fallback) and never exceeds
 *    NOTIFICATION_TITLE_MAX code points. `notification.title` is a Strapi
 *    `string`, i.e. varchar(255) on Postgres, and a source title of up to
 *    255 characters plus "New announcement: " overflowed it: Postgres
 *    answered 22001 and aborted the surrounding transaction despite the
 *    catch (QW-FX18a). Too long values are cut with an ellipsis, the longest
 *    first, so the fixed text ("New announcement: ", the quotes around a
 *    commented title) survives. Counted in code points, as Postgres counts
 *    characters (an emoji is one character there, two UTF-16 units in JS).
 *  - writeNotifications: one strapi.db.query(...).create() per row, NEVER
 *    createMany(): @strapi/database's createMany skips attachRelations, so
 *    `recipient`/`actor` (join-table relations) would be dropped and every
 *    row would be invisible to its recipient (§5.9). Each row in its own
 *    transaction (LF02): a failing INSERT rolls back alone, is logged, and
 *    the next recipient still gets theirs.
 *  - runSourceFanout: the audience-wide fan-out of a published announcement
 *    or event. Loads the audience, keeps the per-recipient re-publish dedup
 *    of resolveFanout (issue #12, §5.26) and fails open there; any error is
 *    logged and never thrown into the lifecycle. scheduleSourceFanout runs
 *    it after the publish transaction commits (LF02, utils/after-commit.ts),
 *    so nothing it does can fail the publish, and a publish that rolls back
 *    notifies nobody.
 */
import { afterCommit, inOwnTransaction, type CommitAwareDb } from "./after-commit";
import {
  resolveFanout,
  type FanoutStrapi,
  type NotificationSourceType,
  type SourceRow,
} from "./notification-source";

export const NOTIFICATION_UID = "api::notification.notification";

/** varchar(255): notification.title is a Strapi `string`. */
export const NOTIFICATION_TITLE_MAX = 255;

const ELLIPSIS = "…";

/** notification.type (schema enum). */
export type NotificationType = "announcement" | "comment" | "event" | "kudos";

/**
 * One piece of a title: fixed text, or a value that falls back to
 * `fallback` when it is not a string or blank. Only values are shortened.
 */
export type TitlePart = string | { value: unknown; fallback: string };

/** The source anchor of a fan-out notification (§5.26). */
export interface NotificationSource {
  sourceType: NotificationSourceType;
  /** documentId of the source; null when the source had none. */
  sourceDocumentId: string | null;
}

export interface NotificationInput {
  type: NotificationType;
  titleParts: readonly TitlePart[];
  link: string;
  recipient: number;
  actor?: number | null;
  source?: NotificationSource | null;
}

/** The create() payload of one notification (a type alias: usable as a plain record). */
export type NotificationData = {
  type: NotificationType;
  title: string;
  link: string;
  recipient: number;
  actor: number | null;
  sourceType?: NotificationSourceType;
  sourceDocumentId?: string | null;
};

interface ResolvedPart {
  chars: string[];
  /** A real value (shortened when too long); fixed text and fallbacks are kept whole. */
  shrinkable: boolean;
}

function resolvePart(part: TitlePart): ResolvedPart {
  if (typeof part === "string") return { chars: Array.from(part), shrinkable: false };
  const value = typeof part.value === "string" ? part.value.trim() : "";
  if (value === "") return { chars: Array.from(part.fallback), shrinkable: false };
  return { chars: Array.from(value), shrinkable: true };
}

/** Length of the title when every value longer than `cap` is cut to `cap` plus the ellipsis. */
function lengthWithCap(parts: readonly ResolvedPart[], cap: number): number {
  let total = 0;
  for (const part of parts) {
    total += part.shrinkable && part.chars.length > cap ? cap + 1 : part.chars.length;
  }
  return total;
}

/**
 * The title from its parts, at most `max` code points. Values are cut to a
 * common length (the longest ones first) and end in "…"; if the fixed text
 * alone is too long, the whole title is cut.
 */
export function buildTitle(parts: readonly TitlePart[], max = NOTIFICATION_TITLE_MAX): string {
  const resolved = parts.map(resolvePart);
  const longest = Math.max(0, ...resolved.filter((p) => p.shrinkable).map((p) => p.chars.length));
  let cap = longest;
  while (cap > 0 && lengthWithCap(resolved, cap) > max) cap -= 1;
  const title = resolved
    .map((part) =>
      part.shrinkable && part.chars.length > cap
        ? part.chars.slice(0, cap).join("") + ELLIPSIS
        : part.chars.join(""),
    )
    .join("");
  const chars = Array.from(title);
  return chars.length <= max ? title : chars.slice(0, max - 1).join("") + ELLIPSIS;
}

/** The notification row for one recipient. */
export function buildNotification(input: NotificationInput): NotificationData {
  const row: NotificationData = {
    type: input.type,
    title: buildTitle(input.titleParts),
    link: input.link,
    recipient: input.recipient,
    actor: input.actor ?? null,
  };
  if (input.source) {
    row.sourceType = input.source.sourceType;
    row.sourceDocumentId = input.source.sourceDocumentId;
  }
  return row;
}

/** The slice of the Strapi instance the writer needs (a superset of FanoutStrapi). */
export interface NotifyStrapi extends FanoutStrapi {
  db: CommitAwareDb & {
    query: (uid: string) => {
      findMany: (params: {
        where: Record<string, unknown>;
        populate: Record<string, unknown>;
      }) => Promise<unknown>;
      create: (params: { data: NotificationData }) => Promise<unknown>;
    };
  };
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
}

/**
 * Writes the rows one create() at a time (never createMany, see the header),
 * each in its own transaction, and logs the result as
 * `[notifications] created <n> notification(s) for <label>` (plus
 * `, <k> failed`). A failing row is logged as an error and skipped: it rolls
 * back alone, the others are written, and the next publish delivers the
 * missing ones (the #12 dedup is per recipient). Meant to run after the
 * source's transaction committed; inside an open transaction the per-row
 * transactions would join it.
 */
export async function writeNotifications(
  strapi: NotifyStrapi,
  rows: readonly NotificationData[],
  label: string,
): Promise<number> {
  let written = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await inOwnTransaction(strapi.db, () =>
        strapi.db.query(NOTIFICATION_UID).create({ data: row }),
      );
      written += 1;
    } catch (err) {
      failed += 1;
      strapi.log.error(
        `[notifications] could not create the notification for user ${row.recipient} (${label}): ${(err as Error).message}`,
      );
    }
  }
  strapi.log.info(
    `[notifications] created ${written} notification(s) for ${label}` +
      (failed > 0 ? `, ${failed} failed` : ""),
  );
  return written;
}

/**
 * The `where` that re-reads a published source row after the commit: the
 * document's current published row by documentId (the row id changes on
 * every publish, §5.17), or the row id when the lifecycle row carries no
 * documentId.
 */
export function publishedRowWhere(row: SourceRow): Record<string, unknown> {
  const documentId = typeof row.documentId === "string" ? row.documentId.trim() : "";
  if (documentId === "") return { id: row.id };
  return { documentId, publishedAt: { $notNull: true } };
}

/** What a fan-out's audience loader returns. */
export interface SourceAudience<TSource extends SourceRow> {
  /** The re-read source row (anchor, title); null when it could not be read. */
  source: TSource | null;
  /** User ids to notify: targeted, the actor already excluded. */
  recipients: readonly number[];
  /** The author / organizer, stored as the notification's actor. */
  actorId: number | null;
}

export interface SourceFanoutOptions<TSource extends SourceRow> {
  strapi: NotifyStrapi;
  sourceType: NotificationSourceType;
  /** The lifecycle's result row (the anchor when the re-read found nothing). */
  row: TSource;
  loadAudience: () => Promise<SourceAudience<TSource>>;
  /** The title of the notification, from the lifecycle row. */
  titleParts: (row: TSource) => readonly TitlePart[];
  link: string;
}

/**
 * The fan-out of a published announcement or event: audience → #12 dedup
 * (resolveFanout, per recipient, fail-open) → one anchored row per new
 * recipient. An empty audience writes nothing, so nothing anchors the source
 * and the next publish evaluates the audience again. Never throws: an error
 * is logged as `[notifications] failed to create notifications for <type>`.
 */
export async function runSourceFanout<TSource extends SourceRow>(
  options: SourceFanoutOptions<TSource>,
): Promise<void> {
  const { strapi, sourceType, row } = options;
  try {
    const { source, recipients, actorId } = await options.loadAudience();
    const { recipients: toNotify, anchor } = await resolveFanout(
      strapi,
      sourceType,
      source ?? row,
      recipients,
      (id: number) => id,
    );
    const titleParts = options.titleParts(row);
    const notificationSource: NotificationSource = {
      sourceType,
      sourceDocumentId: anchor?.sourceDocumentId ?? null,
    };
    const rows = toNotify.map((recipient) =>
      buildNotification({
        type: sourceType,
        titleParts,
        link: options.link,
        recipient,
        actor: actorId,
        source: notificationSource,
      }),
    );
    await writeNotifications(
      strapi,
      rows,
      `${sourceType} ${row.id} (source ${anchor?.sourceDocumentId ?? "unanchored"})`,
    );
  } catch (err) {
    strapi.log.error(
      `[notifications] failed to create notifications for ${sourceType}: ${(err as Error).message}`,
    );
  }
}

/**
 * Fan-outs of this process run one after the other. Commit callbacks are
 * started without being awaited, so two fan-outs registered by one
 * transaction (afterCreate and afterUpdate of an in-place publish) or by two
 * quick publishes would otherwise run their check-then-insert dedup at the
 * same time and notify twice; in sequence the second one finds the first
 * one's rows. It also keeps a bulk publish from starting every fan-out at
 * once.
 */
let fanoutChain: Promise<void> = Promise.resolve();

function enqueueFanout(task: () => Promise<void>): Promise<void> {
  const next = fanoutChain.then(task, task);
  fanoutChain = next.catch(() => undefined);
  return next;
}

/** Exposed for tests: resolves once every fan-out started so far has finished. */
export function __fanoutsSettledForTest(): Promise<void> {
  return fanoutChain;
}

/**
 * runSourceFanout once the publish transaction has committed (LF02): the
 * fan-out reads the committed audience, its INSERTs cannot fail the
 * publish, and a publish that rolls back notifies nobody. Without an open
 * transaction (a db-layer write from a script) it runs right away. Either
 * way it waits for the fan-outs before it (enqueueFanout).
 * Resolves when the fan-out is registered or, without a transaction, done.
 */
export function scheduleSourceFanout<TSource extends SourceRow>(
  options: SourceFanoutOptions<TSource>,
): Promise<void> {
  const { strapi, sourceType } = options;
  return afterCommit(
    strapi.db,
    () => enqueueFanout(() => runSourceFanout(options)),
    (err) =>
      strapi.log.error(
        `[notifications] failed to create notifications for ${sourceType}: ${(err as Error)?.message}`,
      ),
  );
}
