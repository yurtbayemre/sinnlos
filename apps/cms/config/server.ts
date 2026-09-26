// Cross-boundary import into src/ is fine: tsconfig rootDir is "." and the
// compiled dist/ mirrors config/ + src/ side by side (same pattern in the
// other direction: src/extensions/users-permissions imports
// config/ms-role-map). The module runs no code at load time — config files
// are loaded before the `strapi` global exists.
import { sendDigests } from "../src/digest/send-digests";
import { pruneSearchLogs } from "../src/cron/prune-search-logs";
import { sweepOrphanedUploads } from "../src/cron/sweep-orphaned-uploads";
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
  // before; no extra dep). `rule` is a 5-field cron pattern, `tz` its zone:
  // @strapi/core 5.55.1 dist/services/cron.js:65-69 hands `tz` to croner as
  // `timezone`. Every task runs at its wall-clock time in APP_TIME_ZONE; the
  // process zone (UTC in the container) plays no part.
  cron: {
    enabled: true,
    tasks: {
      // Nightly at 03:30 APP_TIME_ZONE — AFTER the 03:00 pg-backup (host
      // crontab, in the host zone: keep the host in APP_TIME_ZONE, see
      // docs/DEPLOYMENT.md), so every swept file is still in the backup.
      "uploads-janitor": {
        task: ({ strapi }: { strapi: any }) => sweepOrphanedUploads(strapi),
        options: { rule: "30 3 * * *", tz: cronTimeZone(env) },
      },
      // 90-day retention for the anonymous search telemetry (issue #19),
      // after the 03:00 pg-backup like the uploads janitor.
      "search-log-janitor": {
        task: ({ strapi }: { strapi: any }) => pruneSearchLogs(strapi),
        options: { rule: "35 3 * * *", tz: cronTimeZone(env) },
      },
      // Morning e-mail digests (issue #18): daily users every day, weekly
      // users on Mondays — the per-user decision lives in digest-plan.ts;
      // without SMTP_* env the run is a logged no-op.
      "digest-mailer": {
        task: ({ strapi }: { strapi: any }) => sendDigests(strapi),
        options: { rule: "30 7 * * *", tz: cronTimeZone(env) },
      },
    },
  },
});
