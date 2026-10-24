import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileTailwind, ruleBody, themeValue } from "./tailwind-css.test.helper";
import {
  CONTRAST_PAIRS,
  DEFAULT_TOKENS,
  contrast,
  failingPairs,
  toRgb,
  type Hsl,
} from "./contrast";

/**
 * WCAG contrast of the colour tokens in globals.css, both themes (FX31,
 * v0.29). Before FX31 dark `text-destructive` was 1.9:1, white labels on
 * light `bg-destructive` 3.6:1 and on dark `bg-primary` 4.4:1; before v0.29
 * the poll percentage on your own vote was 4.06:1, the file-button hover
 * 4.42:1, the dark KPI bars 2.36:1 and the dark progress fill 2.87:1.
 *
 * The pairs (lib/contrast.ts CONTRAST_PAIRS) mirror how the UI combines the
 * tokens. The tokens are parsed from the stylesheet itself, so a changed
 * value is checked as it ships, and DEFAULT_TOKENS must equal them.
 */
const CSS = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");

/** The custom properties declared in the first block for `selector`. */
function tokensOf(selector: string): Record<string, Hsl> {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const block = CSS.slice(start, CSS.indexOf("}", start));
  const tokens: Record<string, Hsl> = {};
  for (const [, name, h, s, l] of block.matchAll(
    /--([a-z-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%;/g,
  )) {
    tokens[name!] = [Number(h), Number(s), Number(l)];
  }
  return tokens;
}

const themes = { light: tokensOf(":root"), dark: tokensOf(".dark") };

describe("the contrast helper", () => {
  it("matches known WCAG values", () => {
    expect(contrast(toRgb([0, 0, 0]), toRgb([0, 0, 100]))).toBeCloseTo(21, 5);
    expect(contrast(toRgb([0, 0, 100]), toRgb([0, 0, 100]))).toBeCloseTo(1, 5);
    // #767676 on white is the classic 4.54:1.
    expect(contrast(toRgb([0, 0, 46.27]), toRgb([0, 0, 100]))).toBeCloseTo(4.54, 1);
  });
});

describe("tailwind text colours (FX31)", () => {
  it("map text-primary / text-destructive to the text tokens and keep the rest", async () => {
    const css = await compileTailwind([
      "text-primary",
      "text-destructive",
      "text-primary-foreground",
      "text-destructive-foreground",
      "bg-primary",
      "bg-destructive",
      "border-primary",
      "ring-destructive",
      "bg-primary-text",
      "accent-primary-text",
    ]);
    for (const name of ["primary", "destructive"]) {
      expect(ruleBody(css, `.text-${name}`)).toBe(`color: var(--text-color-${name});`);
      expect(themeValue(css, `--text-color-${name}`)).toBe(`hsl(var(--${name}-text))`);
      // text-*-foreground falls through to the shared colour.
      expect(ruleBody(css, `.text-${name}-foreground`)).toBe(
        `color: var(--color-${name}-foreground);`,
      );
      expect(themeValue(css, `--color-${name}-foreground`)).toBe(`hsl(var(--${name}-foreground))`);
      // Fills (bg-, border-, ring-) keep the fill tokens.
      expect(ruleBody(css, `.bg-${name}`)).toBe(`background-color: var(--color-${name});`);
      expect(themeValue(css, `--color-${name}`)).toBe(`hsl(var(--${name}))`);
    }
    expect(ruleBody(css, ".border-primary")).toBe("border-color: var(--color-primary);");
    expect(ruleBody(css, ".ring-destructive")).toBe("--tw-ring-color: var(--color-destructive);");
    // v0.29: indicators read the verified text token.
    expect(themeValue(css, "--color-primary-text")).toBe("hsl(var(--primary-text))");
    expect(ruleBody(css, ".bg-primary-text")).toBe("background-color: var(--color-primary-text);");
    expect(ruleBody(css, ".accent-primary-text")).toBe("accent-color: var(--color-primary-text);");
  });
});

describe.each(Object.entries(themes))("%s theme tokens", (name, parsed) => {
  it("DEFAULT_TOKENS mirrors globals.css", () => {
    const defaults = DEFAULT_TOKENS[name as keyof typeof DEFAULT_TOKENS];
    for (const [token, value] of Object.entries(defaults)) {
      expect(parsed[token], `--${token}`).toEqual(value);
    }
  });

  it.each(CONTRAST_PAIRS.map((pair) => [pair.id, pair] as const))("%s", (_id, pair) => {
    expect(contrast(pair.fg(parsed), pair.bg(parsed))).toBeGreaterThanOrEqual(pair.min);
  });

  it("has no failing pair", () => {
    expect(failingPairs(parsed)).toEqual([]);
  });
});
