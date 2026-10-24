/**
 * WCAG contrast of the colour tokens (FX31; v0.29 S1): the helpers, the
 * default tokens of app/globals.css, and every rendered pair the UI draws
 * with them. lib/theme-contrast.test.ts proves the defaults (and that
 * DEFAULT_TOKENS mirrors globals.css); deriveAccentPalette verifies an
 * operator's SITE_ACCENT against the same list before it is used.
 *
 * Classification (WCAG 1.4.3 / 1.4.11):
 *   - text: 4.5:1 (no large-text exception is taken);
 *   - graphic: 3:1, for indicators that carry meaning (focus rings, bars,
 *     progress fills, the route progress, the unread dot, the selected quiz
 *     option's border, checked native controls, icons in tinted tiles); all
 *     of them draw with the primary-text token (bg-/border-/accent-primary-text);
 *   - decorative, not checked: border-primary/* outlines next to a text or
 *     icon cue, the sign-in glow (bg-primary/10 blur), shadows, and solid
 *     bg-primary shapes whose label carries the meaning (buttons, the brand
 *     tile; today's date also gets a primary-text ring).
 */
export type Hsl = readonly [number, number, number];
export type Rgb = readonly [number, number, number];
export type Tokens = Readonly<Record<string, Hsl>>;
export type ThemeName = "light" | "dark";

export function toRgb([h, s, l]: Hsl): Rgb {
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
export const over = (top: Rgb, alpha: number, bottom: Rgb): Rgb =>
  top.map((c, i) => c * alpha + bottom[i]! * (1 - alpha)) as unknown as Rgb;

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export const AA_TEXT = 4.5;
export const AA_GRAPHIC = 3;

/**
 * The tokens of app/globals.css (`:root` and `.dark`) the pairs read; the
 * test pins them to the stylesheet, so they cannot drift apart.
 */
export const DEFAULT_TOKENS: Record<ThemeName, Tokens> = {
  light: {
    background: [0, 0, 100],
    foreground: [222.2, 47.4, 11.2],
    card: [0, 0, 100],
    "card-foreground": [222.2, 47.4, 11.2],
    primary: [243, 75, 59],
    "primary-foreground": [210, 40, 98],
    "primary-text": [243, 75, 59],
    muted: [210, 40, 96.1],
    "muted-foreground": [215.4, 16.3, 45],
    accent: [210, 40, 96.1],
    destructive: [0, 72, 45],
    "destructive-foreground": [210, 40, 98],
    "destructive-text": [0, 72, 40],
    ring: [243, 75, 59],
  },
  dark: {
    background: [222.2, 47.4, 8],
    foreground: [210, 40, 98],
    card: [222.2, 47.4, 11],
    "card-foreground": [210, 40, 98],
    primary: [243, 75, 63],
    "primary-foreground": [210, 40, 98],
    "primary-text": [243, 85, 74],
    muted: [217.2, 32.6, 17.5],
    "muted-foreground": [215, 20.2, 65.1],
    accent: [217.2, 32.6, 17.5],
    destructive: [0, 62.8, 30.6],
    "destructive-foreground": [210, 40, 98],
    "destructive-text": [0, 91, 71],
    ring: [243, 75, 65],
  },
};

type Layer = (t: Tokens) => Rgb;

/** One rendered pair: `fg` drawn on `bg`, needing `min`:1. */
export interface ContrastPair {
  id: string;
  min: number;
  fg: Layer;
  bg: Layer;
}

const tok =
  (name: string): Layer =>
  (t) => {
    const value = t[name];
    if (!value) throw new Error(`contrast: no --${name} token`);
    return toRgb(value);
  };
const tint =
  (fill: string, alpha: number, under: Layer): Layer =>
  (t) =>
    over(tok(fill)(t), alpha, under(t));
const textOver =
  (fg: Layer, alpha: number, under: Layer): Layer =>
  (t) =>
    over(fg(t), alpha, under(t));

const SURFACES = ["background", "card"] as const;

/** `fg` on `bg(surface)` for the page background and the card. */
function onSurfaces(
  id: string,
  min: number,
  fg: Layer,
  bg: (surface: Layer) => Layer,
): ContrastPair[] {
  return SURFACES.map((s) => ({ id: `${id} over ${s}`, min, fg, bg: bg(tok(s)) }));
}

const same = (surface: Layer) => surface;

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  // Text on its surface; secondary text also on the selected search result
  // (aria-selected:bg-accent) and chips on bg-muted.
  { id: "foreground on background", min: AA_TEXT, fg: tok("foreground"), bg: tok("background") },
  { id: "card-foreground on card", min: AA_TEXT, fg: tok("card-foreground"), bg: tok("card") },
  ...onSurfaces("muted-foreground", AA_TEXT, tok("muted-foreground"), same),
  {
    id: "muted-foreground on accent",
    min: AA_TEXT,
    fg: tok("muted-foreground"),
    bg: tok("accent"),
  },
  { id: "muted-foreground on muted", min: AA_TEXT, fg: tok("muted-foreground"), bg: tok("muted") },
  // Fill labels; buttons also hover to bg-primary/90.
  {
    id: "primary-foreground on primary",
    min: AA_TEXT,
    fg: tok("primary-foreground"),
    bg: tok("primary"),
  },
  ...onSurfaces("primary-foreground on primary/90", AA_TEXT, tok("primary-foreground"), (s) =>
    tint("primary", 0.9, s),
  ),
  {
    id: "destructive-foreground on destructive",
    min: AA_TEXT,
    fg: tok("destructive-foreground"),
    bg: tok("destructive"),
  },
  // text-primary / text-destructive read the *-text tokens.
  ...onSurfaces("primary-text", AA_TEXT, tok("primary-text"), same),
  ...onSurfaces("destructive-text", AA_TEXT, tok("destructive-text"), same),
  { id: "primary-text on accent", min: AA_TEXT, fg: tok("primary-text"), bg: tok("accent") },
  { id: "primary-text on muted", min: AA_TEXT, fg: tok("primary-text"), bg: tok("muted") },
  // Chips, active navigation, tiles and toggles: bg-primary/10 text-primary.
  ...onSurfaces("primary-text on primary/10", AA_TEXT, tok("primary-text"), (s) =>
    tint("primary", 0.1, s),
  ),
  ...onSurfaces("destructive-text on destructive/10", AA_TEXT, tok("destructive-text"), (s) =>
    tint("destructive", 0.1, s),
  ),
  ...onSurfaces("destructive-text on destructive/5", AA_TEXT, tok("destructive-text"), (s) =>
    tint("destructive", 0.05, s),
  ),
  // The fetch-error banner line: text-destructive/80 on bg-destructive/5.
  ...SURFACES.map((s) => {
    const bg = tint("destructive", 0.05, tok(s));
    return {
      id: `destructive-text/80 on destructive/5 over ${s}`,
      min: AA_TEXT,
      fg: textOver(tok("destructive-text"), 0.8, bg),
      bg,
    };
  }),
  // The bell's unread row (bg-primary/4) and its icon tile (bg-primary/10
  // text-primary, nested on the row; the icon is a graphic).
  ...onSurfaces("muted-foreground on primary/4", AA_TEXT, tok("muted-foreground"), (s) =>
    tint("primary", 0.04, s),
  ),
  ...onSurfaces("foreground on primary/4", AA_TEXT, tok("foreground"), (s) =>
    tint("primary", 0.04, s),
  ),
  ...onSurfaces("primary-text on primary/10 on primary/4", AA_GRAPHIC, tok("primary-text"), (s) =>
    tint("primary", 0.1, tint("primary", 0.04, s)),
  ),
  // Highlighted announcement (bg-primary/2), the current wiki version
  // (bg-primary/5) and the announcement card's gradient start
  // (from-primary/6; the rest of the gradient is lighter).
  ...[0.02, 0.05, 0.06].flatMap((alpha) =>
    ["foreground", "muted-foreground", "primary-text"].flatMap((text) =>
      onSurfaces(`${text} on primary/${alpha * 100}`, AA_TEXT, tok(text), (s) =>
        tint("primary", alpha, s),
      ),
    ),
  ),
  // The poll's own vote: the bar (bg-primary/15) under the option
  // (text-primary) and its percentage (text-foreground).
  ...["foreground", "primary-text"].flatMap((text) =>
    onSurfaces(`${text} on primary/15`, AA_TEXT, tok(text), (s) => tint("primary", 0.15, s)),
  ),
  // The marketplace file button: text-primary on bg-primary/10, hover /15,
  // over the field's bg-muted/40.
  ...[0.1, 0.15].flatMap((alpha) =>
    onSurfaces(
      `primary-text on primary/${alpha * 100} on muted/40`,
      AA_TEXT,
      tok("primary-text"),
      (s) => tint("primary", alpha, tint("muted", 0.4, s)),
    ),
  ),
  // Graphics: focus rings (offset on the background or a card), KPI bars,
  // the read-confirmation progress fill (on the card and the muted track), the
  // route progress, the active navigation bar, the ring round today in the
  // calendar, checked native controls, the borders of the selected quiz option
  // and RSVP (outside on the card, inside on their /10 tint, checked above) and
  // the unread dot on the bell's /4 row.
  ...onSurfaces("ring", AA_GRAPHIC, tok("ring"), same),
  ...onSurfaces("primary-text graphic", AA_GRAPHIC, tok("primary-text"), same),
  ...onSurfaces("primary-text graphic on primary/4", AA_GRAPHIC, tok("primary-text"), (s) =>
    tint("primary", 0.04, s),
  ),
  {
    id: "primary-text graphic on muted",
    min: AA_GRAPHIC,
    fg: tok("primary-text"),
    bg: tok("muted"),
  },
];

export interface FailingPair {
  id: string;
  ratio: number;
  min: number;
}

/** Every pair below its minimum for these tokens; empty means the palette passes. */
export function failingPairs(tokens: Tokens): FailingPair[] {
  const failing: FailingPair[] = [];
  for (const pair of CONTRAST_PAIRS) {
    const ratio = contrast(pair.fg(tokens), pair.bg(tokens));
    if (ratio < pair.min) failing.push({ id: pair.id, ratio, min: pair.min });
  }
  return failing;
}

/** The four tokens an operator's accent replaces, per theme. */
export type AccentTokens = Record<"primary" | "primary-foreground" | "primary-text" | "ring", Hsl>;

/** The two label colours a fill may carry: white or a dark navy. */
const LABELS: readonly Hsl[] = [
  [0, 0, 100],
  [222, 47, 11],
];

const round1 = (n: number) => Math.round(n * 10) / 10;

/** `#rrggbb` as HSL (degrees, percent), or null for anything else. */
export function hexToHsl(hex: string): Hsl | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!match) return null;
  const [r, g, b] = match.slice(1).map((part) => parseInt(part, 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, round1(l * 100)];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [round1((h * 60 + 360) % 360), round1(s * 100), round1(l * 100)];
}

const withLightness = ([h, s]: Hsl, l: number): Hsl => [h, s, Math.min(100, Math.max(0, l))];

/** Whether a pair reads the text or ring token (a different text colour can fix it). */
const readsText = (id: string) => id.includes("primary-text") || id.startsWith("ring");

function deriveTheme(base: Tokens, accent: Hsl, theme: ThemeName): AccentTokens | null {
  // A label passes "on the fill" when it does on the solid fill and on its
  // /90 hover (every bg-primary button has both); otherwise common brand
  // colours (#0f766e, #ff0000, mid greys) would fall back on the hover alone.
  const labelPasses = (fill: Hsl, label: Hsl) =>
    contrast(toRgb(label), toRgb(fill)) >= AA_TEXT &&
    SURFACES.every(
      (s) => contrast(toRgb(label), over(toRgb(fill), 0.9, toRgb(base[s]!))) >= AA_TEXT,
    );
  // The text (and ring) colour steps darker on the light theme, lighter on
  // the dark one, until every pair passes; null as soon as a pair fails that
  // only the fill decides (a tint under muted text, a label).
  const direction = theme === "light" ? -1 : 1;
  const withText = (fill: Hsl, label: Hsl): AccentTokens | null => {
    for (let l = fill[2]; l >= 0 && l <= 100; l += direction) {
      const text = withLightness(fill, l);
      const tokens: AccentTokens = {
        primary: fill,
        "primary-foreground": label,
        "primary-text": text,
        ring: text,
      };
      const failing = failingPairs({ ...base, ...tokens });
      if (failing.length === 0) return tokens;
      if (failing.some((pair) => !readsText(pair.id))) return null;
    }
    return null;
  };
  // The fill keeps the accent unless neither label passes on it; then it
  // steps away from the better label until one does.
  let fill = accent;
  for (let step = 0; step <= 100; step++) {
    const label = LABELS.find((candidate) => labelPasses(fill, candidate));
    if (label) return withText(fill, label);
    const lightLabelWins =
      contrast(toRgb(LABELS[0]!), toRgb(fill)) >= contrast(toRgb(LABELS[1]!), toRgb(fill));
    fill = withLightness(fill, fill[2] + (lightLabelWins ? -1 : 1));
  }
  return null;
}

const derived = new Map<string, Record<ThemeName, AccentTokens> | null>();

/**
 * The accent tokens of both themes for `#rrggbb`, verified against every
 * pair; null when the value is malformed or no derivation passes (the caller
 * keeps the default tokens). Memoised per value.
 */
export function deriveAccentPalette(hex: string): Record<ThemeName, AccentTokens> | null {
  const key = hex.trim().toLowerCase();
  if (derived.has(key)) return derived.get(key)!;
  const accent = hexToHsl(key);
  const light = accent && deriveTheme(DEFAULT_TOKENS.light, accent, "light");
  const dark = accent && deriveTheme(DEFAULT_TOKENS.dark, accent, "dark");
  const palette = light && dark ? { light, dark } : null;
  derived.set(key, palette);
  return palette;
}

const cssHsl = ([h, s, l]: Hsl) => `${round1(h)} ${round1(s)}% ${round1(l)}%`;

/**
 * The palette as CSS custom properties for both themes. Built from numbers
 * only; `:root.dark` outranks the stylesheet's `.dark` block, and the
 * unlayered rule outranks its `:root` one.
 */
export function paletteCss(palette: Record<ThemeName, AccentTokens>): string {
  const block = (tokens: AccentTokens) =>
    Object.entries(tokens)
      .map(([name, value]) => `--${name}:${cssHsl(value)};`)
      .join("");
  return `:root{${block(palette.light)}}:root.dark{${block(palette.dark)}}`;
}
