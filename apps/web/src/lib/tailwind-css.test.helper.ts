import { readFileSync } from "node:fs";
import { join } from "node:path";
import tailwind from "@tailwindcss/postcss";
import postcss from "postcss";

const WEB = join(__dirname, "..", "..");
export const GLOBALS_CSS_PATH = join(WEB, "src", "app", "globals.css");
export const GLOBALS_CSS = readFileSync(GLOBALS_CSS_PATH, "utf8");

/**
 * The stylesheet as Tailwind 4 builds it from globals.css (the @theme block
 * is the config since the v4 migration), for exactly `candidates`: no file
 * scan, so the output holds only the utilities a test asks about.
 */
export async function compileTailwind(candidates: readonly string[]): Promise<string> {
  const source = GLOBALS_CSS.replace(
    /@import ['"]tailwindcss['"];/,
    `@import "tailwindcss" source(none);\n@source inline("${candidates.join(" ")}");`,
  );
  if (source === GLOBALS_CSS) throw new Error("globals.css no longer imports tailwindcss");
  const out = await postcss([tailwind({ base: WEB })]).process(source, { from: GLOBALS_CSS_PATH });
  return out.css;
}

/** The declarations of the first rule for `selector` in compiled CSS. */
export function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no rule ${selector}`);
  return css.slice(start + selector.length + 2, css.indexOf("}", start)).trim();
}

/** The value of a custom property as the compiled theme declares it. */
export function themeValue(css: string, property: string): string {
  const match = new RegExp(`${property}:\\s*([^;]+);`).exec(css);
  if (!match) throw new Error(`no ${property}`);
  return match[1]!.trim();
}
