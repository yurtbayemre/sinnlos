// Cross-boundary import into src/ is fine: tsconfig rootDir is "." and the
// compiled dist/ mirrors config/ + src/ side by side (config/database.ts
// imports src/database/session-zone the same way). The module runs no code
// at load time — config files are loaded before the `strapi` global exists.
import { buildCronTasks, cronEnabled, cronRegistry } from "../src/cron/registry";
import { resolveAppTimeZone } from "../src/utils/time";

type Env = ((key: string, def?: unknown) => any) & {
  int: (key: string, def?: number) => number;
  bool: (key: string, def?: boolean) => boolean;
  array: (key: string, def?: string[]) => string[];
};

/**
 * The business zone (datetime contract, src/utils/time.ts). Resolved while
 * the config loads, so an empty or unknown APP_TIME_ZONE fails the boot
 * instead of silently scheduling the crons in another zone.
 */
const cronTimeZone = (env: Env): string => resolveAppTimeZone(env("APP_TIME_ZONE"));

export default ({ env }: { env: Env }) => ({
  host: env("HOST", "0.0.0.0"),
  port: env.int("PORT", 1337),
  app: {
    keys: env.array("APP_KEYS"),
  },
  url: env("PUBLIC_URL", "http://localhost:1337"),
  // Trust X-Forwarded-* (FX11). Strapi 5 decides trust ONLY from
  // `server.proxy.koa` (@strapi/core dist/services/server/index.js:23; since
  // 5.52 it also passes `server.proxy.ipHeader`/`maxIpsCount`, unset here, so
  // Koa keeps its defaults); the v4 spelling
  // `proxy: true` was silently ignored, so ctx.request.ip was the web
  // container for every sign-in and the users-permissions throttle
  // (plugin rateLimit middleware: noIdentifier:<path>:<ip> for /auth/local,
  // 10 requests/min by default) pooled ALL local logins into one bucket.
  // Now the client IP the web forwards as X-Forwarded-For keys the bucket.
  // Spoofing needs direct network access: Traefik and Caddy overwrite a
  // client-supplied X-Forwarded-For, and only containers on the shared
  // frontend network reach the cms without them (IN04). Operator invariant:
  // that holds for the host Traefik only while its entrypoint trusts no
  // client X-Forwarded-* (no forwardedHeaders.insecure; trustedIPs only for
  // proxies that overwrite the header) — Koa takes the LEFTMOST entry and
  // Strapi sets no maxIpsCount (noted in infra/.env.example and
  // docker-compose.traefik.yml).
  // Side effects:
  //  - intended: ctx.request.secure follows X-Forwarded-Proto, so the admin
  //    refresh cookie is Secure behind the TLS edge in production.
  //  - accepted: the admin-panel throttle on POST /admin/login and
  //    /admin/register-admin (@strapi/admin middlewares/rateLimit.js, key
  //    `${email}:${path}:${ip}`, 5 per 5 minutes) is now per e-mail AND
  //    client IP. Before, one global bucket per admin e-mail let anyone lock
  //    that admin out; now guessing scales with the attacker's IPs, and a
  //    spoofable X-Forwarded-For would leave it unthrottled.
  proxy: { koa: true },
  // Strapi-native cron (croner via @strapi/core since 5.54, node-schedule
  // before; no extra dep). The tasks live in src/cron/registry.ts (LF03):
  // name, 5-field rule and zone per task, each wrapped with duration logging
  // and an in-process overlap guard. `tz` is APP_TIME_ZONE for every task:
  // @strapi/core 5.55.1 dist/services/cron.js hands it to croner as
  // `timezone`, so a task runs at its wall-clock time in APP_TIME_ZONE and
  // the process zone (UTC in the container) plays no part. The janitors run
  // after the 03:00 host backup (keep the host in APP_TIME_ZONE,
  // docs/DEPLOYMENT.md §7.3). CRON_ENABLED=0 (or false/no/off) switches
  // every task off: with `enabled` false @strapi/core
  // (dist/providers/cron.js) adds none of them.
  cron: {
    enabled: cronEnabled(env("CRON_ENABLED")),
    tasks: buildCronTasks(cronRegistry(cronTimeZone(env))),
  },
});
