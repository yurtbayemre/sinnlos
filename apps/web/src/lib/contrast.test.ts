import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOKENS,
  deriveAccentPalette,
  failingPairs,
  hexToHsl,
  paletteCss,
  type ThemeName,
} from "./contrast";

/**
 * SITE_ACCENT (v0.29, S1): one colour becomes the four accent tokens of
 * each theme, and only a palette that passes every pair of
 * CONTRAST_PAIRS is used; anything else keeps the defaults.
 */
describe("hexToHsl", () => {
  it("converts #rrggbb and refuses everything else", () => {
    expect(hexToHsl("#ffffff")).toEqual([0, 0, 100]);
    expect(hexToHsl("#000000")).toEqual([0, 0, 0]);
    expect(hexToHsl("#ff0000")).toEqual([0, 100, 50]);
    expect(hexToHsl("#4f46e5")).toEqual([243.4, 75.4, 58.6]);
    for (const value of ["", "fff", "#fff", "#gggggg", "#4f46e5aa", "red"]) {
      expect(hexToHsl(value), value).toBeNull();
    }
  });
});

describe("deriveAccentPalette", () => {
  const COLOURS = [
    "#fefefe", // nearly white
    "#050505", // nearly black
    "#ffeb3b", // saturated yellow
    "#777777", // mid grey
    "#ff0000",
    "#00ff00",
    "#0000ff",
    "#4f46e5", // the default indigo
    "#0f766e",
  ];

  // Whether each colour derives a palette (null = the defaults stay).
  const EXPECTED: Record<string, boolean> = {
    "#fefefe": true,
    "#050505": false, // the dark fill under muted text on its tints
    "#ffeb3b": true,
    "#777777": true,
    "#ff0000": true,
    "#00ff00": true,
    "#0000ff": false, // muted text on the /6 gradient start: 4.497:1
    "#4f46e5": true,
    "#0f766e": true,
  };

  it.each(COLOURS)("%s: a derived palette passes every pair, else there is none", (hex) => {
    const palette = deriveAccentPalette(hex);
    expect(palette !== null, hex).toBe(EXPECTED[hex]);
    if (!palette) return;
    for (const theme of ["light", "dark"] as ThemeName[]) {
      expect(failingPairs({ ...DEFAULT_TOKENS[theme], ...palette[theme] }), theme).toEqual([]);
    }
  });

  it("returns null when the derived palette fails a pair the fill decides", () => {
    const accent = hexToHsl("#0000ff")!;
    const tokens = {
      ...DEFAULT_TOKENS.light,
      primary: accent,
      "primary-foreground": [0, 0, 100] as const,
    };
    expect(failingPairs(tokens).map((pair) => pair.id)).toContain(
      "muted-foreground on primary/6 over background",
    );
    expect(deriveAccentPalette("#0000ff")).toBeNull();
  });

  it("keeps the colour as the fill when a label passes on it", () => {
    expect(deriveAccentPalette("#4f46e5")?.light.primary).toEqual(hexToHsl("#4f46e5"));
  });

  it("moves a fill no label passes on to the nearest lightness that works", () => {
    const accent = hexToHsl("#777777")!;
    const fill = deriveAccentPalette("#777777")!.light.primary;
    expect(fill[0]).toBe(accent[0]);
    expect(fill[2]).not.toBe(accent[2]);
  });

  it("refuses a malformed value", () => {
    expect(deriveAccentPalette("teal")).toBeNull();
  });
});

describe("paletteCss", () => {
  it("writes both themes from numbers only", () => {
    const css = paletteCss(deriveAccentPalette("#0f766e")!);
    expect(css).toMatch(
      /^:root\{(--[a-z-]+:[\d.]+ [\d.]+% [\d.]+%;){4}\}:root\.dark\{(--[a-z-]+:[\d.]+ [\d.]+% [\d.]+%;){4}\}$/,
    );
  });
});
