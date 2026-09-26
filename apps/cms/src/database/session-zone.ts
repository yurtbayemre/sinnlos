/**
 * Postgres session time zone pin (datetime contract, deep-dive decision 04,
 * C2 and the Codex amendment "reject conflicting DATABASE_URL options").
 *
 * Every cms connection runs with TimeZone=UTC. It is set in the startup
 * packet through the pg `options` connection parameter (pg 8.13.1
 * lib/client.js:443-445 sends `options`; no extra round trip, and it covers
 * the migration and schema-sync connections too). That makes every
 * session-dependent cast deterministic: knex's `.alter()` of a timestamptz
 * column back to `timestamp` (what Strapi emits for a `column` override),
 * `now()::timestamp`, and the conversions of the timestamptz guard.
 *
 * DATABASE_URL can silently undo the pin: pg merges the parsed connection
 * string OVER the config object (lib/connection-parameters.js:55-57), and
 * pg-connection-string 2.12.0 copies every query parameter (index.js:40-42).
 * A URL with its own `options=` therefore replaces '-c TimeZone=UTC'
 * entirely. Such a URL is refused at config load, unless its options pin
 * TimeZone to UTC themselves.
 */

/** The libpq `options` value every cms Postgres connection uses. */
export const DB_SESSION_OPTIONS = "-c TimeZone=UTC";

const UTC_SETTING_VALUES = new Set(["utc", "etc/utc", "gmt", "etc/gmt", "zulu", "etc/zulu", "uct", "etc/uct"]);

/** The query-string `options` of a Postgres URL, or null when it has none. */
export function databaseUrlOptions(url: string): string | null {
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  if (!query) return null;
  // URLSearchParams decodes %20 and '+' like pg-connection-string's URL parser.
  const params = new URLSearchParams(query.split("#")[0]);
  return params.has("options") ? (params.get("options") ?? "") : null;
}

/** The last TimeZone a libpq options string sets (`-c TimeZone=X` or `--TimeZone=X`), or null. */
export function timeZoneFromPgOptions(options: string): string | null {
  const settings = /(?:^|\s)(?:-c\s*|--)timezone=(\S+)/gi;
  let zone: string | null = null;
  for (let match = settings.exec(options); match; match = settings.exec(options)) {
    zone = match[1].replace(/^['"]|['"]$/g, "");
  }
  return zone;
}

/**
 * Throws when DATABASE_URL would replace the UTC session pin: its own
 * `options` parameter that does not set TimeZone=UTC. No URL, or a URL
 * without `options`, keeps the pin (pg only overrides keys the URL has).
 */
export function assertDatabaseUrlKeepsUtcSession(url: string | undefined | null): void {
  if (!url) return;
  const options = databaseUrlOptions(url);
  if (options === null) return;
  const zone = timeZoneFromPgOptions(options);
  if (zone !== null && UTC_SETTING_VALUES.has(zone.toLowerCase())) return;
  throw new Error(
    "DATABASE_URL sets its own `options` query parameter, which replaces the cms's " +
      `"${DB_SESSION_OPTIONS}" session pin (pg merges the URL over the connection config). ` +
      "Remove `options` from DATABASE_URL, or include -c TimeZone=UTC in it " +
      "(docs/DEPLOYMENT.md, datetime contract).",
  );
}
