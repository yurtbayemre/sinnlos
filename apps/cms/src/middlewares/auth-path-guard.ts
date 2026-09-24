/**
 * Global CMS-side block for case-variant / encoded spellings of Strapi's own
 * `/api/auth/*` routes (roadmap D-EDGE-01).
 *
 * The edge sends `/api/auth/*` to the WEB (Auth.js, prio 100) and every other
 * `/api/*` path to cms (prio 50). But the two layers disagree on case:
 *   - Traefik `PathPrefix(`/api/auth`)` is a RAW, case-sensitive string
 *     prefix (infra/docker-compose.traefik.yml, sinnlos-auth router), so
 *     `/api/Auth/local` misses the web router and falls to the cms router;
 *   - Strapi's koa routers match case-INsensitively: @koa/router defaults to
 *     `sensitive: false` (@koa/router 12 lib/router.js:638) and Strapi never
 *     sets it (@strapi/core 5.49 services/server/api.js:12, routing.js:97).
 * So `/api/Auth/local` from the internet reached Strapi's local login (and
 * register / forgot / reset / change-password) directly — bypassing the web
 * login rate limiter (apps/web/src/lib/login-rate-limit.ts) and, with the
 * shared per-web-IP Strapi throttle (FX11), able to lock out every local
 * login. (Caddy's `path` matcher is case-insensitive, so the standalone
 * stack was not affected.)
 *
 * Rule: a request whose raw OR once-decoded path, posix-normalised and
 * lowercased, is `/api/auth` or lies under `/api/auth/` — but whose RAW path
 * does not literally start with the lowercase `/api/auth/` — gets a bare
 * 404, exactly like an unmatched route. Every legitimate caller is internal
 * (web server actions/auth.ts, infra/live-smoke.sh → http://cms:1337) and
 * sends the literal lowercase path; the literal lowercase form is routed to
 * the web at the edge anyway, so letting it through opens nothing.
 *
 * Decode + normalise mirrors middlewares/uploads-auth.ts (a raw `startsWith`
 * would miss `//`, `..`, `%61uth` and `%2f` forms).
 */
import { posix } from "node:path";

/** Strapi's default content-API prefix (config `api.rest.prefix`). */
export const DEFAULT_REST_PREFIX = "/api";

/**
 * True when `rawPath` spells Strapi's auth routes in any form other than the
 * literal lowercase `<prefix>/auth/…` — i.e. the request must be refused.
 */
export function isCaseVariantAuthPath(rawPath: string, prefix = DEFAULT_REST_PREFIX): boolean {
  if (rawPath.startsWith(`${prefix}/auth/`)) return false;

  const target = `${prefix}/auth`.toLowerCase();
  const forms = [rawPath];
  try {
    forms.push(decodeURIComponent(rawPath));
  } catch {
    // Malformed %-escape: only the raw form is checked (the router cannot
    // match it either).
  }
  return forms.some((form) => {
    const norm = posix.normalize(form.replace(/\\/g, "/")).toLowerCase();
    return norm === target || norm.startsWith(`${target}/`);
  });
}

interface GuardContext {
  path?: string;
  status?: number;
}

export default (
  _config: unknown,
  { strapi }: { strapi: { config: { get(key: string, fallback?: unknown): unknown } } },
) => {
  const configured = strapi.config.get("api.rest.prefix", DEFAULT_REST_PREFIX);
  const prefix = typeof configured === "string" && configured ? configured : DEFAULT_REST_PREFIX;
  return async (ctx: GuardContext, next: () => Promise<unknown>) => {
    if (isCaseVariantAuthPath(ctx.path || "", prefix)) {
      ctx.status = 404;
      return;
    }
    return next();
  };
};
