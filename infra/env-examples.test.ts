/**
 * The .env.example files document every setting the code reads (B05, env
 * part; batch 10, lane 5A):
 *   1. every key apps/cms/config/*.ts reads through Strapi's env() appears
 *      in apps/cms/.env.example (set or commented out),
 *   2. every variable infra/docker-compose.yml and the Traefik overlay
 *      interpolate appears in infra/.env.example,
 *   3. Strapi telemetry is off and the cms cron jobs are on in both
 *      examples, as compose defaults them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** Keys an env file sets or shows commented out (`KEY=` / `# KEY=`). */
function documentedKeys(example: string): Set<string> {
  return new Set(
    example
      .split("\n")
      .map((line) => line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter((key): key is string => key !== undefined),
  );
}

const CMS_EXAMPLE = read("../apps/cms/.env.example");
const INFRA_EXAMPLE = read("./.env.example");

describe("apps/cms/.env.example", () => {
  const configDir = new URL("../apps/cms/config/", import.meta.url);
  const configKeys = [
    ...new Set(
      readdirSync(configDir)
        .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
        .flatMap((file) => [
          ...read(`../apps/cms/config/${file}`).matchAll(
            /\benv(?:\.(?:int|float|bool|json|array|date))?\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
          ),
        ])
        .map((match) => match[1]),
    ),
  ].sort();

  it("finds the config keys", () => {
    expect(configKeys).toContain("DATABASE_FORCE_MIGRATION");
    expect(configKeys).toContain("FLAG_NPS");
  });

  it("documents every key apps/cms/config reads", () => {
    const documented = documentedKeys(CMS_EXAMPLE);
    expect(configKeys.filter((key) => !documented.has(key))).toEqual([]);
  });
});

describe("infra/.env.example", () => {
  const variables = (compose: string): string[] =>
    [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]);
  const composeVariables = [
    ...new Set([
      ...variables(read("./docker-compose.yml")),
      ...variables(read("./docker-compose.traefik.yml")),
    ]),
  ].sort();

  it("documents every variable the compose files interpolate", () => {
    expect(composeVariables).toContain("DOMAIN");
    const documented = documentedKeys(INFRA_EXAMPLE);
    expect(composeVariables.filter((key) => !documented.has(key))).toEqual([]);
  });
});

describe("cms runtime defaults in both examples", () => {
  it.each([
    ["apps/cms/.env.example", CMS_EXAMPLE],
    ["infra/.env.example", INFRA_EXAMPLE],
  ])("%s disables Strapi telemetry and keeps the cron jobs on", (_file, example) => {
    const lines = example.split("\n");
    expect(lines).toContain("STRAPI_TELEMETRY_DISABLED=true");
    expect(lines).toContain("CRON_ENABLED=true");
  });
});
