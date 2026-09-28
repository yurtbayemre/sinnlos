import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * UI01: an element with a transform is the containing block of its `fixed`
 * descendants. PageFade wraps every page, so its entrance animation must
 * not leave the final `translateY(0)` behind: fill mode `backwards`, never
 * `both` or `forwards`. The same holds for the `.stagger` children (every
 * card grid). The overlays stay portaled to <body> for the 0.3 s the
 * transform exists.
 */
vi.mock("next/navigation", () => ({ usePathname: () => "/wiki" }));

const { PageFade } = await import("./page-fade");

const RETAINS_STYLE = /\b(both|forwards)\b/;

describe("entrance animations leave no transform behind (UI01)", () => {
  it("PageFade uses the fade-in-up animation", () => {
    const html = renderToStaticMarkup(createElement(PageFade, null, "content"));
    expect(html).toContain('class="animate-fade-in-up"');
  });

  it("fade-in-up animates a transform and fills backwards only", async () => {
    const { default: resolveConfig } = await import("tailwindcss/resolveConfig");
    const { default: config } = await import("../../tailwind.config");
    const theme = resolveConfig(config).theme as unknown as {
      animation: Record<string, string>;
      keyframes: Record<string, Record<string, Record<string, string>>>;
    };
    expect(JSON.stringify(theme.keyframes["fade-in-up"])).toContain("transform");
    expect(theme.animation["fade-in-up"]).toMatch(/\bbackwards$/);
    expect(theme.animation["fade-in-up"]).not.toMatch(RETAINS_STYLE);
  });

  it("the .stagger children fill backwards only", () => {
    const css = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");
    const rule = /\.stagger > \* \{\s*animation:\s*([^;]+);/.exec(css)?.[1];
    expect(rule).toMatch(/^fade-in-up .*\bbackwards$/);
    expect(rule).not.toMatch(RETAINS_STYLE);
  });
});
