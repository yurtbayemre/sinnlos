/**
 * Operational settings of infra/docker-compose.yml that nothing else checks
 * (batch 10, lane 5A):
 *   1. every service logs through the json-file driver with rotation
 *      (IN05), so a chatty container cannot fill the host's disk;
 *   2. the internal URLs use the unique aliases sinnlos-db, sinnlos-cms and
 *      sinnlos-web, defined on the project's own network only (IN04);
 *   3. the cms gets CRON_ENABLED (default true) for its cron registry
 *      (LF03) and runs without Strapi telemetry (B05).
 *
 * Line-based like container-start.test.ts: the repo has no YAML parser at
 * the root, and the checks only need the service blocks as written.
 * `docker compose config` (CI job `infra`) checks that the file renders.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const COMPOSE = readFileSync(new URL("./docker-compose.yml", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);

const SERVICES = ["db", "cms", "web", "caddy"] as const;

/**
 * The lines of a top-level block (`x-logging: …`) or a service block
 * (`  cms:`), without blank and comment lines.
 */
function block(header: string): string[] {
  const lines = COMPOSE.split("\n");
  const start = lines.indexOf(header);
  expect(start, header).toBeGreaterThanOrEqual(0);
  const indent = header.length - header.trimStart().length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => new RegExp(`^ {0,${indent}}\\S`).test(line));
  return (end === -1 ? rest : rest.slice(0, end)).filter(
    (line) => line.trim() !== "" && !line.trim().startsWith("#"),
  );
}

describe("compose logging (IN05)", () => {
  it("defines one json-file anchor with 5 files of 10 MB", () => {
    expect(block("x-logging: &default-logging")).toEqual([
      "  driver: json-file",
      "  options:",
      '    max-size: "10m"',
      '    max-file: "5"',
    ]);
  });

  it.each(SERVICES)("%s logs through the anchor", (service) => {
    expect(block(`  ${service}:`)).toContain("    logging: *default-logging");
  });

  it("names every service of the file", () => {
    const services = block("services:")
      .map((line) => line.match(/^ {2}([a-z]+):$/)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(services.sort()).toEqual([...SERVICES].sort());
  });
});

describe("internal service names (IN04)", () => {
  /** service → its alias on the project's own (default) network */
  const ALIASES = { db: "sinnlos-db", cms: "sinnlos-cms", web: "sinnlos-web" } as const;

  it.each(Object.entries(ALIASES))("%s has the alias %s on the default network", (service, alias) => {
    const lines = block(`  ${service}:`);
    const start = lines.indexOf("    networks:");
    expect(start, `${service} networks`).toBeGreaterThanOrEqual(0);
    expect(lines.slice(start, start + 4)).toEqual([
      "    networks:",
      "      default:",
      "        aliases:",
      `          - ${alias}`,
    ]);
  });

  // The generic service names resolve on every network a container joins,
  // in Traefik mode also on the shared `frontend` network.
  it.each([
    ["cms", "      DATABASE_HOST: sinnlos-db"],
    ["cms", "      WEB_INTERNAL_URL: http://sinnlos-web:3000"],
    ["web", "      STRAPI_URL: http://sinnlos-cms:1337"],
  ])("%s reaches its peer by alias: %s", (service, line) => {
    expect(block(`  ${service}:`)).toContain(line);
  });

  it("uses no generic service name in an internal URL", () => {
    expect(COMPOSE).not.toMatch(/https?:\/\/(db|cms|web):\d/);
    expect(COMPOSE).not.toMatch(/DATABASE_HOST: db\b/);
  });

  // The Traefik overlay adds `frontend` and must not put an alias there.
  // (See also the `infra` CI job, which checks the merged render.)
  it("keeps the aliases off the shared frontend network", () => {
    const overlay = readFileSync(
      new URL("./docker-compose.traefik.yml", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(overlay).not.toMatch(/aliases:/);
  });
});

describe("cms runtime switches (LF03, B05)", () => {
  it.each([
    "      CRON_ENABLED: ${CRON_ENABLED:-true}",
    "      STRAPI_TELEMETRY_DISABLED: ${STRAPI_TELEMETRY_DISABLED:-true}",
  ])("passes %s to the cms", (line) => {
    expect(block("  cms:")).toContain(line);
  });
});
