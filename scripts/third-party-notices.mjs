#!/usr/bin/env node
// Third-party notices for an image (v0.26, M1): turns the JSON of
// `pnpm licenses list --json` (read from stdin) into THIRD_PARTY_NOTICES.txt
// (written to the path in argv[2]): name, version and license of every
// package version, followed by the LICENSE / LICENCE / COPYING / NOTICE files
// in its directory. Run in each Dockerfile's deps stage, where the lockfile
// and the store are. Versions without such a file are listed on stderr for
// review; the run still succeeds.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const NOTICE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

/** The notice files' text in one package directory, or [] when it has none. */
function noticeTexts(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => NOTICE_FILE.test(name))
    .sort()
    .map((name) => `--- ${name}\n${readFileSync(join(dir, name), "utf8").trimEnd()}`);
}

/**
 * pnpm 10's shape: { "<license>": [{ name, versions[], paths[], license }] },
 * versions[i] lives at paths[i]. Returns the notices text and the
 * "name@version" entries without a notice file.
 */
export function buildNotices(report) {
  const blocks = [];
  const missing = [];
  const entries = Object.values(report)
    .flat()
    .flatMap((pkg) => pkg.versions.map((version, i) => ({ ...pkg, version, path: pkg.paths[i] })))
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  for (const entry of entries) {
    const id = `${entry.name}@${entry.version}`;
    const texts = noticeTexts(entry.path);
    if (texts.length === 0) missing.push(id);
    blocks.push(
      [
        `=== ${id} (${entry.license})`,
        ...(texts.length ? texts : ["(no license file found)"]),
      ].join("\n"),
    );
  }
  const header =
    "sinnlos is licensed under the GNU Affero General Public License v3.0 only (LICENSE).\n" +
    "It ships the following third-party packages under their own licenses.\n";
  return { text: `${header}\n${blocks.join("\n\n")}\n`, missing };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: pnpm licenses list --json | node third-party-notices.mjs <out-file>");
    process.exit(2);
  }
  const { text, missing } = buildNotices(JSON.parse(readFileSync(0, "utf8")));
  writeFileSync(out, text);
  if (missing.length) {
    console.error(`[notices] review: ${missing.length} package version(s) without a license file:`);
    for (const id of missing) console.error(`  ${id}`);
  }
}
