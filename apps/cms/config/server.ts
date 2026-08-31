// Cross-boundary import into src/ is fine: tsconfig rootDir is "." and the
// compiled dist/ mirrors config/ + src/ side by side (same pattern in the
// other direction: src/extensions/users-permissions imports
// config/ms-role-map). The module runs no code at load time — config files
// are loaded before the `strapi` global exists.
import { pruneSearchLogs } from "../src/cron/prune-search-logs";
import { sweepOrphanedUploads } from "../src/cron/sweep-orphaned-uploads";

type Env = ((key: string, def?: unknown) => any) & {
  int: (key: string, def?: number) => number;
  bool: (key: string, def?: boolean) => boolean;
  array: (key: string, def?: string[]) => string[];
};

export default ({ env }: { env: Env }) => ({
  host: env("HOST", "0.0.0.0"),
  port: env.int("PORT", 1337),
  app: {
    keys: env.array("APP_KEYS"),
  },
  url: env("PUBLIC_URL", "http://localhost:1337"),
  proxy: true,
  // Strapi-native cron (node-schedule via @strapi/core, no extra dep).
  cron: {
    enabled: true,
    tasks: {
      // Nightly at 03:30 Europe/Berlin (TZ is pinned in the container,
      // the tz option makes it explicit anyway) — AFTER the 03:00
      // pg-backup, so every swept file is still in the previous backup.
      "uploads-janitor": {
        task: ({ strapi }: { strapi: any }) => sweepOrphanedUploads(strapi),
        options: { rule: "30 3 * * *", tz: "Europe/Berlin" },
      },
      // 90-day retention for the anonymous search telemetry (issue #19),
      // after the 03:00 pg-backup like the uploads janitor.
      "search-log-janitor": {
        task: ({ strapi }: { strapi: any }) => pruneSearchLogs(strapi),
        options: { rule: "35 3 * * *", tz: "Europe/Berlin" },
      },
    },
  },
});
