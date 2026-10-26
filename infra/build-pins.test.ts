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
 *   3. .dockerignore keeps local state and caches out of the build context;
 *   4. every GitHub Action in the workflows runs at a full commit SHA with
 *      its release tag in a trailing comment (the form Dependabot updates),
 *      never at a movable tag or branch;
 *   5. one pnpm version everywhere (packageManager, CI, both images), and
 *      pnpm 10's build-script allowlist names the dependencies that need
 *      their install scripts.
 *   6. every compose image runs at a digest (v0.32), CI's edge check runs
 *      the caddy the compose file pins, and Dependabot proposes new digests
 *      of the same tags, never a Postgres or Caddy major.
 */
import { readFileSync, readdirSync } from "node:fs";
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

  it("copies the full dependency tree from deps, then the app from the builder's /out, then the notices", () => {
    expect(copies).toEqual([
      "COPY --from=deps --chown=node:node /app/node_modules /app/node_modules",
      "COPY --from=deps --chown=node:node /app/apps/cms/node_modules /app/apps/cms/node_modules",
      "COPY --from=builder --chown=node:node /out /app",
      "COPY --from=deps /app/THIRD_PARTY_NOTICES.txt /app/THIRD_PARTY_NOTICES.txt",
      "COPY LICENSE /app/LICENSE",
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

describe("GitHub Actions", () => {
  const WORKFLOWS_DIR = new URL("../.github/workflows/", import.meta.url);
  const workflows = readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/.test(name));
  const uses = workflows.flatMap((name) =>
    read(`../.github/workflows/${name}`)
      .split("\n")
      .filter((line) => /^\s*(- )?uses:/.test(line))
      .map((line) => ({ name, line: line.trim().replace(/^- /, "") })),
  );

  it("are used at all (the workflow still parses as expected)", () => {
    expect(workflows).toContain("ci.yml");
    expect(uses.length).toBeGreaterThanOrEqual(4);
  });

  it("run at a full commit SHA with the release tag in a trailing comment", () => {
    for (const { name, line } of uses) {
      expect(line, `${name}: ${line}`).toMatch(
        /^uses: [\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
      );
    }
  });

  it("pin one SHA per action", () => {
    const shaByAction = new Map<string, Set<string>>();
    for (const { line } of uses) {
      const [, action, sha] = /^uses: (\S+)@([0-9a-f]{40})/.exec(line) ?? [];
      if (!action || !sha) continue;
      shaByAction.set(action, (shaByAction.get(action) ?? new Set()).add(sha));
    }
    for (const [action, shas] of shaByAction) expect(shas.size, action).toBe(1);
  });
});

describe("CI's arm64 images for the registry deploy (v0.33)", () => {
  const ci = read("../.github/workflows/ci.yml");
  const job = ci.slice(ci.indexOf("\n  publish:\n"));
  const at = (text: string) => {
    const index = job.indexOf(text);
    expect(index, text).toBeGreaterThan(-1);
    return index;
  };

  it("runs after every check, on a push to main or a manual run that asks for it", () => {
    expect(job).toContain(
      "    needs: [changes, build, datetime, integration, e2e, infra, images]\n",
    );
    expect(job).toContain(
      "      (github.event_name == 'push' && github.ref == 'refs/heads/main') ||\n" +
        "      (github.event_name == 'workflow_dispatch' && inputs.publish)\n",
    );
    expect(ci).toMatch(
      /workflow_dispatch:\n {4}inputs:\n {6}publish:\n[^]*?type: boolean\n {8}default: false\n/,
    );
    expect(job).toContain("    runs-on: ubuntu-24.04-arm\n");
    expect(job).toContain("    permissions:\n      contents: read\n      packages: write\n");
  });

  it("pushes only the image it checked, tagged with the commit, between two private checks", () => {
    const before = at("- name: The package is private (before the push)");
    const build = at("- name: Build apps/${{ matrix.app }}/Dockerfile for arm64");
    const boot = at("- name: Boot-value check in the arm64 cms image");
    const login = at("- name: Log in to ghcr.io");
    const push = at('run: docker push "${IMAGE}"');
    const after = at("- name: The package is still private (after the push)");
    expect([before, build, boot, login, push, after]).toEqual(
      [before, build, boot, login, push, after].sort((a, b) => a - b),
    );
    expect(job).toContain("IMAGE: ghcr.io/yurtbayemre/sinnlos-${{ matrix.app }}:${{ github.sha }}");
    expect(job).toContain("SINNLOS_REVISION=${{ github.sha }}");
    expect(job).toContain("          load: true\n");
    expect(job).not.toMatch(/^\s+push: true$/m);
    expect(job).toContain("scope=image-${{ matrix.app }}-arm64");
    // Only the exact answer "private" lets the push happen.
    expect(job.match(/if \[\[ "\$\{visibility\}" != private \]\]; then/g)).toHaveLength(2);
    expect(job.match(/curl -fsS /g)).toHaveLength(2);
  });

  it("leaves the public release images off (the lawyer gate, owner decision 2026-10-22)", () => {
    const release = read("../.github/workflows/release-images.yml");
    const on = release.slice(release.indexOf("\non:\n"), release.indexOf("\npermissions:"));
    // No push trigger (the `push` input of the manual run stays false by default).
    expect(on).not.toMatch(/^ {2}push:/m);
    expect(on).toContain("workflow_dispatch:");
  });
});

describe("pnpm", () => {
  const manifest = JSON.parse(read("../package.json")) as {
    packageManager: string;
    engines: { pnpm: string };
    pnpm: { onlyBuiltDependencies: string[]; ignoredBuiltDependencies: string[] };
  };
  const [, version] = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager) ?? [];

  it("is one exact pnpm 10 release in packageManager, engines, CI and both images", () => {
    expect(version).toMatch(/^10\./);
    expect(manifest.engines.pnpm).toBe(">=10");
    const prepared = [
      read("../.github/workflows/ci.yml"),
      DOCKERFILES.cms,
      DOCKERFILES.web,
    ].flatMap((text) =>
      [...text.matchAll(/corepack prepare pnpm@(\S+) --activate/g)].map((m) => m[1]),
    );
    // Four CI jobs with Node plus the two images.
    expect(prepared).toHaveLength(6);
    expect(new Set(prepared)).toEqual(new Set([version]));
  });

  it("runs install scripts only for the dependencies that need them", () => {
    expect(manifest.pnpm.onlyBuiltDependencies).toEqual(["esbuild", "sharp"]);
    for (const name of manifest.pnpm.ignoredBuiltDependencies) {
      expect(manifest.pnpm.onlyBuiltDependencies).not.toContain(name);
    }
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
    "e2e",
    ".e2e",
  ])("excludes %s", (pattern) => {
    expect(patterns).toContain(pattern);
  });
});

describe("compose images (v0.32, #196)", () => {
  const compose = read("./docker-compose.yml");
  const images = [...compose.matchAll(/^ {4}image: (\S+)$/gm)].map((match) => match[1]);

  it("pins every image of the compose file by digest, postgres on its 16 line", () => {
    expect(images.length).toBeGreaterThanOrEqual(3);
    for (const image of images) expect(image).toMatch(/^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
    // A digest bump of the same tag (Dependabot) passes; another tag does not.
    expect(images.some((image) => /^postgres:16-alpine@sha256:[0-9a-f]{64}$/.test(image))).toBe(
      true,
    );
    expect(images.some((image) => /^caddy:2-alpine@sha256:[0-9a-f]{64}$/.test(image))).toBe(true);
  });

  it("lets CI's edge check run the caddy the compose file pins, never a floating tag", () => {
    const ci = read("../.github/workflows/ci.yml");
    expect(ci).not.toMatch(/caddy:2-alpine(?!@)/);
    expect(ci).toContain(`image="$(jq -er '.services.caddy.image' <<<"\${config}")"`);
    expect(ci.match(/Caddyfile:ro" "\$\{image\}"/g)).toHaveLength(2);
  });

  it("lets CI and the e2e stack run the postgres the compose file pins, read from it", () => {
    // A Dependabot digest bump of /infra then reaches both without a second copy.
    const ci = read("../.github/workflows/ci.yml");
    expect(ci).not.toMatch(/postgres:16/);
    expect(ci).toContain("postgres: ${{ steps.pins.outputs.postgres }}");
    expect(ci).toContain(
      "image=\"$(sed -n 's/^    image: \\(postgres:[^ ]*\\)$/\\1/p' infra/docker-compose.yml)\"",
    );
    expect(ci.match(/needs\.changes\.outputs\.postgres/g)).toHaveLength(2);
    expect(read("../e2e/compose.yaml")).toContain("image: ${E2E_POSTGRES_IMAGE:?}");
    const runner = read("../e2e/run.mjs");
    expect(runner).toContain("E2E_POSTGRES_IMAGE: await pinnedPostgres(),");
    expect(runner).toContain("/^ {4}image: (postgres:\\S+)$/m.exec(compose)");
    // Both readers find the pinned image in the compose file.
    expect(/^ {4}image: (postgres:\S+)$/m.exec(compose)?.[1]).toMatch(
      /^postgres:16-alpine@sha256:[0-9a-f]{64}$/,
    );
  });

  it("has Dependabot propose new digests of the same tags, never a Postgres or Caddy major", () => {
    const dependabot = read("../.github/dependabot.yml");
    const entry = dependabot.slice(dependabot.indexOf("package-ecosystem: docker-compose"));
    expect(entry).toMatch(/^package-ecosystem: docker-compose\n {4}directory: \/infra\n/);
    const block = entry.slice(0, entry.indexOf("\n\n"));
    for (const name of ["postgres", "caddy"]) {
      expect(block).toContain(
        `- dependency-name: ${name}\n        update-types: ["version-update:semver-major"]`,
      );
    }
    // Meilisearch not at all: a new version may not open the old index files.
    expect(block).toMatch(/- dependency-name: getmeili\/meilisearch\n?$/);
  });
});
