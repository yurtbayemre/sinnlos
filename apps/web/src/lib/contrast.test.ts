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

  it.each(COLOURS)("%s: a derived palette passes every pair, or there is none", (hex) => {
    const palette = deriveAccentPalette(hex);
    if (!palette) return;
    for (const theme of ["light", "dark"] as ThemeName[]) {
      expect(failingPairs({ ...DEFAULT_TOKENS[theme], ...palette[theme] }), theme).toEqual([]);
    }
  });

  it("derives a palette for ordinary brand colours", () => {
    for (const hex of ["#4f46e5", "#0f766e", "#ff0000", "#0000ff", "#777777", "#ffeb3b"]) {
      expect(deriveAccentPalette(hex), hex).not.toBeNull();
    }
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
