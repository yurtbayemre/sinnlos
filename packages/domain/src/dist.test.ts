import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import * as source from "./index.js";

/**
 * The built package against its source. Tests import the source (the root
 * vitest.config.ts aliases @sinnlos/domain to src/index.ts); the cms loads
 * dist/cjs through package.json main/exports "require", the web bundler
 * dist/esm through exports "import". This suite checks that both builds
 * load in Node as what they claim to be and hand out exactly the source's
 * exports.
 *
 * It needs `pnpm build:domain` first. CI builds the package before the
 * tests (.github/workflows/ci.yml), so there a missing dist fails; locally
 * the suite is skipped until dist exists.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CJS_ENTRY = join(ROOT, "dist", "cjs", "index.js");
const ESM_ENTRY = join(ROOT, "dist", "esm", "index.js");
const built = existsSync(CJS_ENTRY) && existsSync(ESM_ENTRY);
const required = process.env.CI === "true";

const sortedKeys = (module: object) => Object.keys(module).sort();

describe.skipIf(!built && !required)("dist", () => {
  it("exists (run pnpm build:domain)", () => {
    expect(built).toBe(true);
  });

  it("dist/cjs is CommonJS and exports exactly the source's names", () => {
    expect(JSON.parse(readFileSync(join(ROOT, "dist", "cjs", "package.json"), "utf8"))).toEqual({
      type: "commonjs",
    });
    const cjs = createRequire(import.meta.url)(CJS_ENTRY) as Record<string, unknown>;
    expect(sortedKeys(cjs)).toEqual(sortedKeys(source));
    expect((cjs.parseEntryRef as typeof source.parseEntryRef)("12")).toEqual({ id: 12 });
  });

  // 30 s like the repo's other cold loads: the dynamic import goes through
  // vitest's module runner, which transformed dist/esm in 5 s once under the
  // full suite on a loaded machine (test:tz, Pacific/Auckland); alone it
  // takes milliseconds.
  it("dist/esm is an ES module and exports exactly the source's names", async () => {
    expect(JSON.parse(readFileSync(join(ROOT, "dist", "esm", "package.json"), "utf8"))).toEqual({
      type: "module",
    });
    const esm = (await import(pathToFileURL(ESM_ENTRY).href)) as Record<string, unknown>;
    expect(sortedKeys(esm)).toEqual(sortedKeys(source));
    expect(
      (esm.zonedDateKey as typeof source.zonedDateKey)("2026-09-30T22:30:00Z", "Europe/Berlin"),
    ).toBe("2026-10-01");
  }, 30_000);

  it("ships the declarations package.json points at", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      main: string;
      types: string;
      exports: Record<string, Record<string, { types: string; default: string }>>;
    };
    const entries = [
      manifest.main,
      manifest.types,
      ...Object.values(manifest.exports["."]).flatMap((entry) => [entry.types, entry.default]),
    ];
    for (const entry of entries) expect(existsSync(join(ROOT, entry)), entry).toBe(true);
  });
});
