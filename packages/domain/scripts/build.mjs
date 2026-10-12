/**
 * Builds @sinnlos/domain into dist/ with the package's own TypeScript:
 *
 *   dist/cjs  CommonJS + .d.ts (package.json main/types, exports "require"):
 *             the cms, which Strapi compiles and runs as CommonJS
 *   dist/esm  ES modules + .d.ts (exports "import"): the web bundler
 *
 * Each output directory gets a package.json naming its module type, so Node
 * reads dist/esm as ESM although the package itself has no "type". The old
 * dist is removed first: a module deleted from src must not live on there.
 */
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

const OUTPUTS = [
  { project: "tsconfig.cjs.json", dir: "cjs", type: "commonjs" },
  { project: "tsconfig.esm.json", dir: "esm", type: "module" },
];

rmSync(join(root, "dist"), { recursive: true, force: true });

for (const { project, dir, type } of OUTPUTS) {
  const run = spawnSync(process.execPath, [tsc, "-p", project], { cwd: root, stdio: "inherit" });
  if (run.status !== 0) {
    console.error(`@sinnlos/domain: tsc -p ${project} failed`);
    process.exit(run.status ?? 1);
  }
  writeFileSync(join(root, "dist", dir, "package.json"), `${JSON.stringify({ type })}\n`);
}
