/**
 * How the images are built (IN02, batch 12 lane 7B). Pinned:
 *   1. each Dockerfile pulls exactly one base image, node:24-alpine by
 *      digest, as the stage `node-base`; every other stage starts FROM a
 *      stage of the same file, and both files pin the same digest. One
 *      FROM line on purpose: Dependabot's docker updater rewrites FROM
 *      lines only (a digest in an ARG default would never be bumped);
 *   2. the cms runtime stage copies the dependency tree straight from the
 *      deps stage (a layer that changes only with the lockfile) and the app
 *      as one more layer from the builder's /out, never the builder's whole
 *      /app;
 *   3. .dockerignore keeps local state and caches out of the build context.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** Instructions of a Dockerfile, comments and blank lines dropped. */
const instructions = (dockerfile: string) =>
  dockerfile
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

const DOCKERFILES = {
  cms: read("../apps/cms/Dockerfile"),
  web: read("../apps/web/Dockerfile"),
};

const NODE_BASE = /^FROM node:24-alpine@sha256:([0-9a-f]{64}) AS node-base$/;

describe("Dockerfile base image", () => {
  it.each(Object.entries(DOCKERFILES))(
    "%s: one pinned node:24-alpine, every other stage builds on a stage",
    (_app, dockerfile) => {
      const froms = instructions(dockerfile).filter((line) => /^FROM\s/i.test(line));
      expect(froms[0]).toMatch(NODE_BASE);
      const stages = ["node-base"];
      for (const from of froms.slice(1)) {
        const match = /^FROM (\S+) AS (\S+)$/.exec(from);
        expect(match, from).not.toBeNull();
        expect(stages, from).toContain(match![1]);
        stages.push(match![2]);
      }
      expect(stages).toContain("runner");
      expect(froms.at(-1)).toBe("FROM node-base AS runner");
    },
  );

  it("is the same digest in both images", () => {
    const [cms, web] = [DOCKERFILES.cms, DOCKERFILES.web].map(
      (dockerfile) => NODE_BASE.exec(instructions(dockerfile)[0])?.[1],
    );
    expect(cms).toBeDefined();
    expect(web).toBe(cms);
  });
});

describe("cms runtime layers", () => {
  const lines = instructions(DOCKERFILES.cms);
  const runner = lines.slice(lines.indexOf("FROM node-base AS runner"));
  const copies = runner.filter((line) => line.startsWith("COPY "));

  it("copies the full dependency tree from deps, then the app from the builder's /out", () => {
    expect(copies).toEqual([
      "COPY --from=deps --chown=node:node /app/node_modules /app/node_modules",
      "COPY --from=deps --chown=node:node /app/apps/cms/node_modules /app/apps/cms/node_modules",
      "COPY --from=builder --chown=node:node /out /app",
    ]);
  });

  it("gathers what `strapi start` reads into /out, with the empty uploads directory", () => {
    const builder = lines.slice(
      lines.indexOf("FROM base AS builder"),
      lines.indexOf("FROM node-base AS runner"),
    );
    const gather = builder.find((line) => line.startsWith("RUN mkdir -p /out/"));
    expect(gather).toBeDefined();
    const script = builder.slice(builder.indexOf(gather!)).join(" ");
    for (const part of [
      "package.json",
      "tsconfig.json",
      "favicon.png",
      "dist",
      "database",
      "public",
    ]) {
      expect(script).toContain(` ${part}`);
    }
    expect(script).toContain("mkdir -p /out/apps/cms/public/uploads");
    expect(script).toContain("../../packages/domain/package.json ../../packages/domain/dist");
  });
});

describe(".dockerignore", () => {
  const patterns = read("../.dockerignore")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  it.each([
    "**/node_modules",
    "**/dist",
    "**/.env",
    "**/.tmp",
    "**/.cache",
    "**/.strapi",
    "apps/cms/public/uploads/*",
    "**/types/generated",
    "**/*.tsbuildinfo",
  ])("excludes %s", (pattern) => {
    expect(patterns).toContain(pattern);
  });
});
