import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The web's local-Date ban (datetime contract, decision 04, C5; D-DT4 web
 * part) mirrors the cms's: every selector of the cms rule is in the web
 * config, as an error, for all files, tests included, with only
 * src/lib/plain-date.ts exempt. Text level on purpose (the mirror tests do
 * the same): no web test loads cms code or the ESLint runtime.
 *
 * Line endings are normalised: a Windows checkout may convert them.
 */
const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const WEB = read("../../eslint.config.mjs");
const CMS = read("../../../cms/eslint.config.mjs");

/** The `selector:` strings of a config text (double-quoted, possibly on the next line). */
function selectors(config: string): string[] {
  return [...config.matchAll(/selector:\s*\n?\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
}

/**
 * The cms's datetime entry alone: from its comment to the `},` that closes
 * the entry (two-space indent), so later cms lint entries with selectors of
 * their own do not count.
 */
function cmsDatetimeEntry(): string {
  const start = CMS.indexOf("// Datetime contract");
  const end = CMS.indexOf("\n  },\n", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return CMS.slice(start, end);
}

describe("web ESLint datetime ban", () => {
  it("carries every local-Date selector of the cms config", () => {
    const cmsDatetime = selectors(cmsDatetimeEntry());
    expect(cmsDatetime).toHaveLength(4);
    const web = selectors(WEB);
    for (const selector of cmsDatetime) expect(web, selector).toContain(selector);
  });

  it("applies them as errors to every file, and exempts only plain-date.ts", () => {
    expect(WEB).toContain(
      '"no-restricted-syntax": ["error", ...NO_SERVER_CACHE_SYNTAX, ...LOCAL_DATE_SYNTAX]',
    );
    // The only other entry of the rule drops the date part, for plain-date.ts alone.
    const entries = [...WEB.matchAll(/"no-restricted-syntax": \[([^\]]*)\]/g)].map((m) => m[1]);
    expect(entries).toEqual([
      '"error", ...NO_SERVER_CACHE_SYNTAX, ...LOCAL_DATE_SYNTAX',
      '"error", ...NO_SERVER_CACHE_SYNTAX',
    ]);
    expect(WEB).toMatch(
      /files: \["src\/lib\/plain-date\.ts"\],\s*rules: \{\s*"no-restricted-syntax": \["error", \.\.\.NO_SERVER_CACHE_SYNTAX\]/,
    );
    expect(WEB).not.toMatch(/ignores: \[[^\]]*plain-date/);
  });

  it("bans temporal-polyfill in the web", () => {
    expect(WEB).toContain('{ name: "temporal-polyfill", message: NO_TEMPORAL_MESSAGE }');
    expect(WEB).toContain('{ group: ["temporal-polyfill/*"], message: NO_TEMPORAL_MESSAGE }');
  });
});
