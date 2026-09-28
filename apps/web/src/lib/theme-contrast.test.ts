import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG contrast of the colour tokens in globals.css, both themes (FX31).
 * Text needs 4.5:1 (AA, normal size). Before FX31 dark `text-destructive`
 * was 1.9:1, white labels on light `bg-destructive` 3.6:1 and on dark
 * `bg-primary` 4.4:1.
 *
 * The pairs mirror how the UI combines the tokens: `text-primary` and
 * `text-destructive` read the *-text tokens (tailwind.config.ts textColor),
 * fills carry their *-foreground, and the error line of the fetch-error
 * banner is `text-destructive/80` on `bg-destructive/5`. The tokens are
 * parsed from the stylesheet itself, so a changed value is checked as it
 * ships.
 */
type Hsl = [number, number, number];
type Rgb = [number, number, number];
type Tokens = Record<string, Hsl>;

const CSS = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");

/** The custom properties declared in the first block for `selector`. */
function tokensOf(selector: string): Tokens {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const block = CSS.slice(start, CSS.indexOf("}", start));
  const tokens: Tokens = {};
  for (const [, name, h, s, l] of block.matchAll(
    /--([a-z-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%;/g,
  )) {
    tokens[name!] = [Number(h), Number(s), Number(l)];
  }
  return tokens;
}

function toRgb([h, s, l]: Hsl): Rgb {
  const sat = s / 100;
  const light = l / 100;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** `top` at `alpha` over the opaque `bottom`. */
const over = (top: Rgb, alpha: number, bottom: Rgb): Rgb =>
  top.map((c, i) => c * alpha + bottom[i]! * (1 - alpha)) as Rgb;

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const AA_TEXT = 4.5;

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
    const { default: resolveConfig } = await import("tailwindcss/resolveConfig");
    const { default: config } = await import("../../tailwind.config");
    const theme = resolveConfig(config).theme as unknown as {
      colors: Record<string, Record<string, string>>;
      textColor: Record<string, Record<string, string>>;
    };
    expect(theme.textColor.primary).toMatchObject({
      DEFAULT: "hsl(var(--primary-text))",
      foreground: "hsl(var(--primary-foreground))",
    });
    expect(theme.textColor.destructive).toMatchObject({
      DEFAULT: "hsl(var(--destructive-text))",
      foreground: "hsl(var(--destructive-foreground))",
    });
    // Fills (bg-, border-, ring-) keep the fill tokens.
    expect(theme.colors.primary!.DEFAULT).toBe("hsl(var(--primary))");
    expect(theme.colors.destructive!.DEFAULT).toBe("hsl(var(--destructive))");
  });
});

describe.each(Object.entries(themes))("%s theme tokens (FX31)", (_name, t) => {
  const c = (name: string): Rgb => {
    expect(t[name], `--${name}`).toBeDefined();
    return toRgb(t[name]!);
  };

  it("declares every token the pairs below use, as bare HSL triplets", () => {
    for (const name of [
      "background",
      "foreground",
      "card",
      "card-foreground",
      "muted-foreground",
      "primary",
      "primary-foreground",
      "primary-text",
      "destructive",
      "destructive-foreground",
      "destructive-text",
    ]) {
      expect(t[name], `--${name}`).toBeDefined();
    }
  });

  it.each([
    ["foreground", "background"],
    ["card-foreground", "card"],
    ["muted-foreground", "background"],
    ["muted-foreground", "card"],
  ])("%s on %s reaches 4.5:1", (text, surface) => {
    expect(contrast(c(text), c(surface))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it.each([
    ["primary-foreground", "primary"],
    ["destructive-foreground", "destructive"],
  ])("%s on the %s fill reaches 4.5:1", (text, fill) => {
    expect(contrast(c(text), c(fill))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it.each(["primary-text", "destructive-text"])(
    "%s reaches 4.5:1 on background and card",
    (text) => {
      for (const surface of ["background", "card"]) {
        expect(contrast(c(text), c(surface)), surface).toBeGreaterThanOrEqual(AA_TEXT);
      }
    },
  );

  it.each([
    ["primary-text", "primary", 0.1],
    ["destructive-text", "destructive", 0.1],
    ["destructive-text", "destructive", 0.05],
  ] as const)("%s reaches 4.5:1 on the %s/%s tint", (text, fill, alpha) => {
    for (const surface of ["background", "card"]) {
      const tint = over(c(fill), alpha, c(surface));
      expect(contrast(c(text), tint), surface).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it("the fetch-error banner line (text-destructive/80 on bg-destructive/5) reaches 4.5:1", () => {
    for (const surface of ["background", "card"]) {
      const tint = over(c("destructive"), 0.05, c(surface));
      const text = over(c("destructive-text"), 0.8, tint);
      expect(contrast(text, tint), surface).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});
