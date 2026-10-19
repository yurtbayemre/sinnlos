import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { compileTailwind, ruleBody, themeValue } from "@/lib/tailwind-css.test.helper";

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
    const css = await compileTailwind(["animate-fade-in-up"]);
    expect(ruleBody(css, ".animate-fade-in-up")).toBe("animation: var(--animate-fade-in-up);");
    const animation = themeValue(css, "--animate-fade-in-up");
    expect(animation).toMatch(/^fade-in-up .*\bbackwards$/);
    expect(animation).not.toMatch(RETAINS_STYLE);
    const keyframes = css.slice(css.indexOf("@keyframes fade-in-up"));
    expect(keyframes.slice(0, keyframes.indexOf("@keyframes", 1))).toContain("transform");
  });

  it("the .stagger children fill backwards only", async () => {
    const css = await compileTailwind(["stagger"]);
    const rule = /\.stagger > \* \{\s*animation:\s*([^;]+);/.exec(css)?.[1];
    expect(rule).toMatch(/^fade-in-up .*\bbackwards$/);
    expect(rule).not.toMatch(RETAINS_STYLE);
  });
});
