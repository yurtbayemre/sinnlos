#!/usr/bin/env node
/**
 * Runs the whole Vitest suite once per process time zone (datetime contract,
 * deep-dive decision 04): results must not depend on the zone the process
 * runs in, because every business date is computed in APP_TIME_ZONE and every
 * instant is compared as an instant.
 *
 *   pnpm test:tz                  # UTC, Europe/Berlin, Pacific/Auckland
 *   pnpm test:tz America/Denver   # only the zones given
 *
 * TZ is set through child_process env on purpose: Git Bash on Windows drops a
 * `TZ=... cmd` prefix for native programs, and cmd.exe has no such syntax.
 * Each run also asserts that the child really runs in the requested zone.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const DEFAULT_ZONES = ["UTC", "Europe/Berlin", "Pacific/Auckland"];
const zones = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_ZONES;

// vitest exports no subpath for its CLI: resolve the package, then its bin.
const require = createRequire(import.meta.url);
const vitestPackageJson = require.resolve("vitest/package.json");
const vitestCli = join(dirname(vitestPackageJson), require(vitestPackageJson).bin.vitest);

const failed = [];
for (const zone of zones) {
  const env = { ...process.env, TZ: zone };
  const probe = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)"],
    { env, encoding: "utf8" },
  );
  const actual = probe.stdout.trim();
  // Node reports TZ=UTC as "UTC" or "Etc/UTC" depending on ICU data.
  const matches = actual === zone || (zone === "UTC" && actual === "Etc/UTC");
  if (!matches) {
    console.error(`test:tz: TZ=${zone} did not take effect (child reports "${actual}")`);
    failed.push(zone);
    continue;
  }
  console.log(`\n=== vitest with TZ=${zone} ===`);
  const run = spawnSync(process.execPath, [vitestCli, "run"], { env, stdio: "inherit" });
  if (run.status !== 0) failed.push(zone);
}

if (failed.length > 0) {
  console.error(`\ntest:tz: FAILED under ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\ntest:tz: passed under ${zones.join(", ")}`);
