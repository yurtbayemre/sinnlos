import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import { navItemsFor, type NavItem } from "@/lib/nav-config";

/**
 * FX30: the sidebar and the phone nav map the same entries (lib/nav-config.ts
 * navItemsFor, SH02). The phone nav shows the primary tabs plus a More
 * trigger for the rest (a Radix dialog: closed in server markup), and the
 * More sheet lists the others with the current one marked. The pathname,
 * the viewer and the server translations are mocked; the client markup uses
 * the real catalogs.
 */
const state = vi.hoisted(() => ({ pathname: "/", role: "member" as string | null }));

vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("@/lib/viewer", () => ({
  getViewer: async () => ({ id: 1, displayName: "V", role: state.role, department: null }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "nav" | "common") => (key: string) =>
    (en[namespace] as Record<string, string>)[key],
}));

const { MobileNav, MoreSheetLinks } = await import("./mobile-nav");
const { Sidebar } = await import("./sidebar");
const { NavLink } = await import("./nav-link");
const { ViewerMobileNav } = await import("./viewer-mobile-nav");

function render(element: ReactElement, locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- a .test.ts has no JSX, and createElement's types want the provider's required children in the props
    createElement(NextIntlClientProvider, {
      locale,
      messages: locale === "en" ? en : de,
      timeZone: "Europe/Berlin",
      children: element,
    }),
  );
}

/** Every element in a returned tree (through children). */
function elements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children as ReactNode)];
}

const links = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]);
/** The hrefs of the links marked as the current page. */
const current = (html: string) =>
  [...html.matchAll(/<a [^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes('aria-current="page"'))
    .map((tag) => /href="([^"]*)"/.exec(tag)?.[1]);

beforeEach(() => {
  state.pathname = "/";
  state.role = "member";
});

describe("MobileNav", () => {
  it("shows the primary tabs and a More trigger for the rest", () => {
    const html = render(createElement(MobileNav, { items: navItemsFor("member") }));
    expect(links(html)).toEqual(["/", "/people", "/events", "/wiki", "/announcements"]);
    expect(html).toContain(`>${en.nav.home}<`);
    expect(html).toContain(`>${en.nav.news}<`);
    expect(html).toContain(`>${en.nav.more}<`);
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"/);
  });

  it("marks the current tab, and the More trigger for a section in the sheet", () => {
    state.pathname = "/events";
    let html = render(createElement(MobileNav, { items: navItemsFor("member") }));
    expect(current(html)).toEqual(["/events"]);
    expect(html).not.toContain('data-active="true"');
    state.pathname = "/marketplace/7";
    html = render(createElement(MobileNav, { items: navItemsFor("member") }));
    expect(current(html)).toEqual([]);
    expect(html).toContain('data-active="true"');
  });

  it("leaves the News tab out for a guest", () => {
    const html = render(createElement(MobileNav, { items: navItemsFor("guest") }));
    expect(links(html)).toEqual(["/", "/people", "/events", "/wiki"]);
    expect(html).toContain(`>${en.nav.more}<`);
  });

  it("has no More trigger when every entry is a tab", () => {
    const primary = navItemsFor("member").filter((item) => item.mobilePrimary);
    const html = render(createElement(MobileNav, { items: primary }));
    expect(html).not.toContain(`>${en.nav.more}<`);
  });

  it("labels the bar in the UI language", () => {
    const html = render(createElement(MobileNav, { items: navItemsFor("member") }), "de");
    expect(html).toContain(`aria-label="${de.common.bottomNav}"`);
    expect(html).toContain(`>${de.nav.more}<`);
  });
});

describe("MoreSheetLinks", () => {
  const more = (role: string) => navItemsFor(role).filter((item) => !item.mobilePrimary);

  it("lists every other section, /manage for an admin only", () => {
    const member = render(
      createElement(MoreSheetLinks, { items: more("member"), pathname: "/", onNavigate() {} }),
    );
    expect(links(member)).toEqual([
      "/training",
      "/departments",
      "/teams",
      "/kudos",
      "/marketplace",
      "/polls",
      "/documents",
    ]);
    const admin = render(
      createElement(MoreSheetLinks, { items: more("admin_role"), pathname: "/", onNavigate() {} }),
    );
    expect(links(admin).at(-1)).toBe("/manage");
    expect(admin).toContain(`>${en.nav.admin}<`);
  });

  it("marks the current section", () => {
    const html = render(
      createElement(MoreSheetLinks, {
        items: more("member"),
        pathname: "/kudos",
        onNavigate() {},
      }),
    );
    expect(current(html)).toEqual(["/kudos"]);
  });

  it("closes the sheet when an entry is chosen", () => {
    const onNavigate = vi.fn();
    // Called inside a render, so its hooks have the provider.
    let list: ReactNode = null;
    render(
      createElement(() => {
        list = MoreSheetLinks({ items: more("member"), pathname: "/", onNavigate });
        return null;
      }),
    );
    const link = elements(list).find((el) => el.props.href === "/kudos");
    expect(link?.props.onClick).toBe(onNavigate);
  });
});

describe("Sidebar and ViewerMobileNav map the viewer's entries", () => {
  const hrefsOf = (items: readonly NavItem[]) => items.map((item) => item.href);

  it.each(["admin_role", "member", "guest", null])("%s", async (role) => {
    state.role = role;
    const sidebar = elements(await Sidebar({}));
    const navLinks = sidebar.filter((el) => el.type === NavLink);
    expect(navLinks.map((el) => el.props.href)).toEqual(hrefsOf(navItemsFor(role)));
    expect(navLinks.map((el) => el.props.label)).toEqual(
      navItemsFor(role).map((item) => en.nav[item.labelKey]),
    );
    const phone = (await ViewerMobileNav()) as ReactElement<{ items: NavItem[] }>;
    expect(phone.type).toBe(MobileNav);
    expect(hrefsOf(phone.props.items)).toEqual(hrefsOf(navItemsFor(role)));
  });
});
