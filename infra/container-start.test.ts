/**
 * How the app containers start (CMS-PNPM-AT-BOOT, 2026-09-27).
 *
 * The cms image used to run `CMD ["pnpm", "start"]` as USER node, while
 * corepack had prepared pnpm for root only at build time: every container
 * start downloaded pnpm from registry.npmjs.org, so a restart or a rollback
 * failed while the registry was unreachable. Pinned here:
 *   1. neither runtime stage needs pnpm or corepack: the cms starts Strapi's
 *      own bin (the pnpm shim that `pnpm start` ran; it execs node), the web
 *      runs node on the standalone server,
 *   2. both run as `node`,
 *   3. compose runs the cms with `init: true` (docker-init forwards SIGTERM
 *      to Strapi, whose own handler shuts down gracefully, and reaps
 *      zombies; without it node is PID 1 and ignores a SIGTERM that arrives
 *      before Strapi installed its handler), and no compose command,
 *      entrypoint or healthcheck of the app services calls pnpm, npx or
 *      corepack.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** Instructions of the last build stage (the runtime image), comments dropped. */
function runtimeStage(dockerfile: string): string[] {
  const lines = dockerfile
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const lastFrom = lines.map((line) => /^FROM\s/i.test(line)).lastIndexOf(true);
  expect(lastFrom).toBeGreaterThanOrEqual(0);
  return lines.slice(lastFrom);
}

function cmdOf(stage: string[]): unknown {
  const cmd = stage.filter((line) => /^CMD\s/i.test(line));
  expect(cmd).toHaveLength(1);
  return JSON.parse(cmd[0].replace(/^CMD\s+/i, ""));
}

/** The lines of one top-level service block in a compose file (two-space indent). */
function serviceBlock(compose: string, service: string): string[] {
  const lines = compose.split("\n");
  const start = lines.indexOf(`  ${service}:`);
  expect(start, `service ${service}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {0,2}\S/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

const PACKAGE_MANAGER = /\b(pnpm|npx|corepack|npm)\b/;

describe("cms image", () => {
  const stage = runtimeStage(read("../apps/cms/Dockerfile"));

  it("starts Strapi's own bin, not pnpm", () => {
    expect(cmdOf(stage)).toEqual(["node_modules/.bin/strapi", "start"]);
  });

  // The base image still ships corepack, npm and yarn; the stage must not
  // set up or call any of them (only the pnpm shim is gone).
  it("sets up and calls no package manager in the runtime stage", () => {
    expect(stage.filter((line) => PACKAGE_MANAGER.test(line))).toEqual([]);
  });

  it("runs as node from the cms directory", () => {
    expect(stage).toContain("USER node");
    expect(stage.filter((line) => /^WORKDIR\s/i.test(line)).at(-1)).toBe("WORKDIR /app/apps/cms");
  });
});

describe("web image", () => {
  const stage = runtimeStage(read("../apps/web/Dockerfile"));

  it("runs node on the standalone server, as node, without pnpm", () => {
    expect(cmdOf(stage)).toEqual(["node", "apps/web/server.js"]);
    expect(stage).toContain("USER node");
    expect(stage.filter((line) => PACKAGE_MANAGER.test(line))).toEqual([]);
  });
});

describe("compose", () => {
  const compose = read("./docker-compose.yml");

  it("runs the cms with docker-init", () => {
    expect(serviceBlock(compose, "cms")).toContain("    init: true");
  });

  it.each(["cms", "web"])(
    "gives %s no command or entrypoint, and no package manager anywhere",
    (service) => {
      const block = serviceBlock(compose, service).filter((line) => !line.trim().startsWith("#"));
      expect(block.filter((line) => /^\s{4}(command|entrypoint):/.test(line))).toEqual([]);
      expect(block.filter((line) => PACKAGE_MANAGER.test(line))).toEqual([]);
    },
  );

  it.each([
    "docker-compose.traefik.yml",
    "docker-compose.cms-legacy-tz.yml",
    "docker-compose.web-legacy-tz.yml",
  ])("%s overrides no start command", (file) => {
    const lines = read(`./${file}`)
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"));
    expect(lines.filter((line) => /^\s+(command|entrypoint|init):/.test(line))).toEqual([]);
    expect(lines.filter((line) => PACKAGE_MANAGER.test(line))).toEqual([]);
  });
});
