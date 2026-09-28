/**
 * Vitest global setup of the Strapi integration suite (S11): compiles the
 * cms ONCE per run, the way `strapi build` / `strapi develop` do
 * (@strapi/typescript-utils `compile`, the compiler behind @strapi/strapi's
 * `compileStrapi`), into a temp directory that also serves as Strapi's app
 * directory. Every suite boots its own Strapi from it
 * (harness.test.helper.ts); the teardown removes it.
 *
 * Layout of the temp root:
 *   dist/{config,src,scripts}   the compiled cms: Strapi's distDir
 *   package.json, favicon.png,  copies from apps/cms: Strapi's appDir, the
 *   database/migrations/        directory it WRITES to (public/uploads, the
 *   public/uploads/             update-check file), so a run never writes
 *                               into apps/cms; the user migrations run from
 *                               here as from apps/cms in production
 *   .strapi-updater.json        marks today's Strapi update check as done:
 *                               createStrapi() would otherwise ask the npm
 *                               registry once a day (@strapi/core
 *                               utils/update-notifier), a network call the
 *                               harness refuses
 *   node_modules                junction/symlink to apps/cms/node_modules, so
 *                               the compiled files resolve the cms
 *                               dependencies exactly as in apps/cms
 *   db/*.db                     the suites' SQLite files (config/database.ts
 *                               resolves DATABASE_FILENAME against
 *                               dist/config/../..)
 *
 * A type error fails the compile (noEmitOnError, like `strapi build`), so a
 * broken cms fails the run here, with the compiler's diagnostics.
 *
 * Named *.test.helper.ts: the Strapi build skips it (tsconfig excludes
 * **\/*.test.*) and neither vitest config collects it as a suite.
 */
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** Temp root of the compiled cms (see the layout above). */
    sinnlosCmsBuild: string;
  }
}

/** apps/cms. */
export const CMS_APP_DIR = resolve(__dirname, "..", "..");

interface TypeScriptUtils {
  compile(
    appDir: string,
    options: {
      configOptions: { options: Record<string, unknown>; ignoreDiagnostics: boolean };
    },
  ): Promise<void>;
}

/** Compiles the cms into a fresh temp root (see the layout above) and returns the root. */
export async function compileCms(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "sinnlos-it-"));
  try {
    const requireFromCms = createRequire(join(CMS_APP_DIR, "package.json"));
    const tsUtils = requireFromCms("@strapi/typescript-utils") as TypeScriptUtils;
    await tsUtils.compile(CMS_APP_DIR, {
      configOptions: {
        // A throwaway output: no incremental build info next to it.
        options: { outDir: join(root, "dist"), incremental: false },
        ignoreDiagnostics: false,
      },
    });
    copyFileSync(join(CMS_APP_DIR, "package.json"), join(root, "package.json"));
    copyFileSync(join(CMS_APP_DIR, "favicon.png"), join(root, "favicon.png"));
    cpSync(join(CMS_APP_DIR, "database", "migrations"), join(root, "database", "migrations"), {
      recursive: true,
    });
    mkdirSync(join(root, "public", "uploads"), { recursive: true });
    mkdirSync(join(root, "db"));
    writeFileSync(
      join(root, ".strapi-updater.json"),
      JSON.stringify({ lastUpdateCheck: Date.now() }),
    );
    // "junction" needs no privileges on Windows and is ignored elsewhere.
    symlinkSync(join(CMS_APP_DIR, "node_modules"), join(root, "node_modules"), "junction");
    return root;
  } catch (err) {
    removeBuild(root);
    throw err;
  }
}

/**
 * Removes a temp root made by compileCms. The node_modules link is unlinked
 * FIRST, so the recursive delete can never walk into apps/cms/node_modules.
 */
export function removeBuild(root: string): void {
  try {
    unlinkSync(join(root, "node_modules"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  rmSync(root, { recursive: true, force: true });
}

export async function setup(project: TestProject): Promise<() => void> {
  const started = Date.now();
  const root = await compileCms();
  console.log(`[integration] compiled the cms in ${Date.now() - started} ms`);
  project.provide("sinnlosCmsBuild", root);
  return () => removeBuild(root);
}
