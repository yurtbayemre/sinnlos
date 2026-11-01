/**
 * `Cache-Control: private, no-store` on every answer under
 * `/api/secret-shares` (v0.35.0, plan §3.9): the list, a share's metadata,
 * the revealed text and every refusal, a 401, a 404 of a switched-off module
 * and a 500 included. Registered outside strapi::errors (config/middlewares.ts),
 * so the header is set before the route runs and set again after
 * strapi::errors wrote its error body.
 *
 * Matched like Strapi's router matches: case-insensitively, on the raw and
 * the once-decoded path (an encoded spelling reaches the same route). A
 * wider match only costs caching.
 */
const PREFIX = "/api/secret-shares";

/** Whether `rawPath` is the secret-share API or below it. */
export function isSecretSharePath(rawPath: string): boolean {
  const forms = [rawPath];
  try {
    forms.push(decodeURIComponent(rawPath));
  } catch {
    // A malformed %-escape: the raw form only.
  }
  return forms.some((form) => {
    const path = form.replace(/\/{2,}/g, "/").toLowerCase();
    return path === PREFIX || path.startsWith(`${PREFIX}/`);
  });
}

interface NoStoreContext {
  path?: string;
  set(field: string, value: string): void;
}

export default () => async (ctx: NoStoreContext, next: () => Promise<unknown>) => {
  if (!isSecretSharePath(ctx.path || "")) return next();
  ctx.set("Cache-Control", "private, no-store");
  try {
    await next();
  } finally {
    ctx.set("Cache-Control", "private, no-store");
  }
};
