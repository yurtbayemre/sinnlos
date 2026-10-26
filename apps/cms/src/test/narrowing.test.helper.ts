import { createVisibilityNarrowing } from "../utils/policy-query";

/**
 * Test helpers for the visibility narrowing (#175, v0.33): a read policy
 * leaves its clause on the request (narrowReads) and the Document Service
 * middleware ANDs it into the read's `params.filters`
 * (createVisibilityNarrowing). Lists go as oneParamIn operands, which a
 * stub db cannot run as SQL: the stub connection's `raw` returns the list
 * as a marker instead, and decodeOneParam turns markers back into arrays.
 */

/** The key of a stub oneParamIn operand: `{ [ONE_PARAM]: values }`. */
export const ONE_PARAM = "__oneParam";

/** A stub `db.connection`: raw() of oneParamIn hands back its list as a marker. */
export const oneParamConnection = {
  raw(sql: string, bindings: unknown[]): Record<string, unknown> {
    const list = sql.includes("json_each") ? JSON.parse(String(bindings[0])) : bindings[0];
    return { [ONE_PARAM]: list };
  },
};

/** The list of a stub oneParamIn operand, or undefined for any other value. */
export function oneParamList(value: unknown): unknown[] | undefined {
  if (typeof value !== "object" || value === null || !(ONE_PARAM in value)) return undefined;
  const list = (value as Record<string, unknown>)[ONE_PARAM];
  return Array.isArray(list) ? list : undefined;
}

/** Every stub oneParamIn operand in `value` replaced by its list (deep copy). */
export function decodeOneParam(value: unknown): unknown {
  const list = oneParamList(value);
  if (list) return list;
  if (Array.isArray(value)) return value.map(decodeOneParam);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        decodeOneParam(entry),
      ]),
    );
  }
  return value;
}

/**
 * Gives a stub what the narrowing needs: the request context (the policy
 * context itself, as Strapi's requestContext holds the Koa context whose
 * `state` the policy context shares) and the stub connection.
 */
export function withNarrowing<T extends { db: object }>(
  strapi: T,
  ctx: object,
): T & {
  requestContext: { get(): unknown };
  db: T["db"] & { connection: typeof oneParamConnection };
} {
  const host = strapi as T & {
    requestContext: { get(): unknown };
    db: T["db"] & { connection: typeof oneParamConnection };
  };
  host.requestContext = { get: () => ctx };
  host.db.connection = oneParamConnection;
  return host;
}

/**
 * The filters a Document Service read of `uid` gets in the request of
 * `ctx`: `filters` (the client's) with what the policies stored ANDed in by
 * the real middleware, lists decoded. Undefined when nothing applies.
 */
export async function narrowedFilters(
  ctx: object,
  uid: string,
  filters?: unknown,
): Promise<unknown> {
  const middleware = createVisibilityNarrowing({ requestContext: { get: () => ctx } });
  const context = { uid, action: "findMany", params: filters === undefined ? {} : { filters } };
  await middleware(context, async () => undefined);
  return decodeOneParam((context.params as { filters?: unknown }).filters);
}

/** The uid a policy stored a clause for in the request of `ctx`, when exactly one. */
export function storedUid(ctx: { state?: object }): string | undefined {
  const stored = (ctx.state as Record<PropertyKey, unknown> | undefined)?.[
    Symbol.for("sinnlos.visibility")
  ] as Map<string, unknown> | undefined;
  const uids = [...(stored?.keys() ?? [])];
  return uids.length === 1 ? uids[0] : undefined;
}
