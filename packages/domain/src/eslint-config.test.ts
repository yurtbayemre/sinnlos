import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The package's local-Date ban (datetime contract, decision 04, C5) carries
 * every selector of the cms rule, like the web's (apps/web/src/lib/
 * eslint-datetime.test.ts), with only src/plain-date.ts exempt. Text level:
 * no ESLint runtime in the test.
 *
 * Line endings are normalised: a Windows checkout may convert them.
 */
const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const DOMAIN = read("../eslint.config.mjs");
const CMS = read("../../../apps/cms/eslint.config.mjs");

/** The `selector:` strings of a config text (double-quoted, possibly on the next line). */
function selectors(config: string): string[] {
  return [...config.matchAll(/selector:\s*\n?\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
}

describe("package ESLint datetime ban", () => {
  it("carries every local-Date selector of the cms config", () => {
    const start = CMS.indexOf("// Datetime contract");
    const end = CMS.indexOf("\n  },\n", start);
    expect(start).toBeGreaterThan(-1);
    const cms = selectors(CMS.slice(start, end));
    expect(cms).toHaveLength(4);
    expect(selectors(DOMAIN)).toEqual(cms);
  });

  it("applies them as errors and exempts only plain-date.ts", () => {
    expect(DOMAIN).toContain('"no-restricted-syntax": ["error", ...LOCAL_DATE_SYNTAX]');
    expect(DOMAIN).toMatch(
      /ignores: \["src\/plain-date\.ts"\],\s*rules: \{\s*"no-restricted-syntax"/,
    );
    expect([...DOMAIN.matchAll(/"no-restricted-syntax"/g)]).toHaveLength(1);
  });
});
