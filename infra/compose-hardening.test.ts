/**
 * Operational settings of infra/docker-compose.yml that nothing else checks
 * (batch 10, lane 5A):
 *   1. every service logs through the json-file driver with rotation
 *      (IN05), so a chatty container cannot fill the host's disk.
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
