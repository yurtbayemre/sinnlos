import { errors } from "@strapi/utils";

/**
 * DT-OFFSETLESS (decision 06 §F; batch 15 plan item 1): a Document Service
 * middleware that answers 400 for an instant written as a string without
 * `Z` or a numeric offset.
 *
 * WHY. Strapi reads an offset-less datetime string in the PROCESS zone
 * (@strapi/database fields/shared/parsers.js parseDateTimeOrTimestamp →
 * date-fns parseISO; C9), which is UTC in the container: a client that
 * forgot to convert "09:00 Berlin" stored 09:00Z, two hours off, without an
 * error. The cms's own code reads instants through utils/time.ts, which
 * refuses such a value; this guard closes the generic content API and the
 * admin panel too (the gap docs/OPERATIONS.md, "Datetime contract", named).
 *
 * WHERE. First in the Document Service chain (bootstrap/document-
 * middlewares.ts), so it answers before any transaction or lock. It sees
 * every Document Service write: the content API (also the open-payload
 * routes, poll today), the Content Manager (C19), scripts. The admin
 * panel's datetime input always sends `toISOString()` and its date input
 * `YYYY-MM-DD` for `date` attributes (@strapi/admin FormInputs/DateTime.js,
 * Date.js; C15), which this guard leaves alone.
 *
 * WHAT. On create, update and clone: every top-level attribute of type
 * `datetime` or `timestamp` whose value in `params.data` is a string that
 * is not an ISO 8601 date-time ending in `Z` or `±hh`, `±hhmm`, `±hh:mm`.
 * Date objects, numbers (epoch milliseconds), null and absent keys pass;
 * `date` and `time` attributes are not instants and are not checked. The
 * answer is a `ValidationError` "Instants need Z or an offset (e.g.
 * 2026-10-01T07:00:00.000Z): <keys>" with `details.keys`.
 *
 * NOT WALKED: components and dynamic zones (the app has none, pinned in
 * offsetless-datetime-guard.test.ts). NOT COVERED by design:
 * `strapi.db.query` writes, which internal code makes with Date objects or
 * ISO-Z (the Kurzliste row "Datetime").
 */

/** The actions that carry `params.data` (repository.js create, update, clone). */
export const OFFSETLESS_GUARDED_ACTIONS: readonly string[] = ["create", "update", "clone"];

const INSTANT_TYPES: ReadonlySet<string> = new Set(["datetime", "timestamp"]);

/** An ISO 8601 date-time that ends in Z or a numeric offset. */
const WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/** Whether `value` is a string an instant attribute must refuse. */
export function isOffsetLessInstantString(value: unknown): boolean {
  return typeof value === "string" && !WITH_OFFSET.test(value.trim());
}

/** The message of the guard's 400, also used by tests and docs. */
export const offsetlessMessage = (keys: readonly string[]): string =>
  `Instants need Z or an offset (e.g. 2026-10-01T07:00:00.000Z): ${keys.join(", ")}`;

interface GuardContext {
  action?: string;
  params?: unknown;
  contentType?: { attributes?: Record<string, { type?: string } | undefined> };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The instant attributes of `data` that hold an offset-less string. */
export function offsetlessKeys(
  attributes: Record<string, { type?: string } | undefined>,
  data: unknown,
): string[] {
  if (!isRecord(data)) return [];
  const offending: string[] = [];
  for (const [key, attribute] of Object.entries(attributes)) {
    if (!INSTANT_TYPES.has(attribute?.type ?? "")) continue;
    if (isOffsetLessInstantString(data[key])) offending.push(key);
  }
  return offending.sort();
}

/** The middleware (see the module comment); covers every uid. */
export function createOffsetlessDatetimeGuard() {
  return async (context: GuardContext, next: () => Promise<unknown>): Promise<unknown> => {
    if (!OFFSETLESS_GUARDED_ACTIONS.includes(context.action ?? "")) return next();
    const data = isRecord(context.params) ? context.params.data : undefined;
    const keys = offsetlessKeys(context.contentType?.attributes ?? {}, data);
    if (keys.length > 0) {
      throw new errors.ValidationError(offsetlessMessage(keys), { keys });
    }
    return next();
  };
}
