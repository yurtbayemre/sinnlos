import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";

/**
 * UI04: the shell's first focusable element is a "Skip to content" link to
 * <main id="main" tabIndex={-1}>, visually hidden until focused, with the
 * label from the catalogs. Sidebar, topbar and mobile nav are stubbed (they
 * read the session and the CMS); PageFade needs only the pathname.
 */
const state = vi.hoisted(() => ({ locale: "en" as "en" | "de" }));

vi.mock("./sidebar", () => ({ Sidebar: () => createElement("nav", { id: "sidebar" }) }));
vi.mock("./topbar", () => ({ Topbar: () => createElement("header", { id: "topbar" }) }));
vi.mock("./mobile-nav", () => ({ MobileNav: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "common") => {
    const catalog = state.locale === "en" ? en : de;
    return (key: keyof (typeof en)["common"]) => catalog[namespace][key];
  },
}));

const { AppShell, MAIN_ID } = await import("./app-shell");

async function render(): Promise<string> {
  return renderToStaticMarkup(await AppShell({ children: createElement("p", null, "page") }));
}

describe("AppShell skip link (UI04)", () => {
  it("puts the skip link before the navigation, pointing at <main>", async () => {
    const html = await render();
    const link = html.indexOf(`<a href="#${MAIN_ID}"`);
    expect(link).toBeGreaterThanOrEqual(0);
    expect(link).toBeLessThan(html.indexOf('id="sidebar"'));
    expect(link).toBeLessThan(html.indexOf('id="topbar"'));
    expect(html).toContain(`<main id="${MAIN_ID}" tabindex="-1"`);
  });

  it("hides the link until it is focused", async () => {
    const html = await render();
    const tag = /<a href="#main" class="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(tag.split(" ")).toEqual(expect.arrayContaining(["sr-only", "focus:not-sr-only"]));
  });

  it("labels the link in the UI language", async () => {
    state.locale = "en";
    expect(await render()).toContain(`>${en.common.skipToContent}</a>`);
    state.locale = "de";
    expect(await render()).toContain(`>${de.common.skipToContent}</a>`);
    state.locale = "en";
  });
});
