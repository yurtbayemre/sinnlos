import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import defaultTheme from "tailwindcss/defaultTheme";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import { navItemsFor, type NavItem } from "@/lib/nav-config";

/**
 * FX30: the sidebar and the phone nav map the same entries (lib/nav-config.ts
 * navItemsFor, SH02). The phone nav shows the primary tabs plus a More
 * trigger for the rest (a Radix dialog: closed in server markup), and the
 * More sheet lists the others with the current one marked. The sheet stays
 * open only on the route it was opened on and below Tailwind `md`, where it
 * is visible (the viewport store is driven by a fake MediaQueryList). Every
 * link shows a pending dot while its navigation runs (UI05, useLinkStatus).
 * The pathname, the link status, the viewer and the server translations
 * are mocked; the client markup uses the real catalogs.
 */
const state = vi.hoisted(() => ({
  pathname: "/",
  role: "member" as string | null,
  pending: false,
}));

vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
// UI05: the links' pending state, per test (the real hook reads the Link's context).
vi.mock("next/link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/link")>()),
  useLinkStatus: () => ({ pending: state.pending }),
}));
vi.mock("@/lib/viewer", () => ({
  getViewer: async () => ({ id: 1, displayName: "V", role: state.role, department: null }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "nav" | "common") => (key: string) =>
    (en[namespace] as Record<string, string>)[key],
}));

const {
  DESKTOP_QUERY,
  MobileNav,
  MoreSheetLinks,
  isDesktopViewport,
  sheetStaysOpen,
  subscribeDesktop,
} = await import("./mobile-nav");
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
/** The More trigger's opening tag (the bar's only button). */
const trigger = (html: string) => /<button [^>]*>/.exec(html)?.[0] ?? "";

beforeEach(() => {
  state.pathname = "/";
  state.role = "member";
  state.pending = false;
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
    expect(trigger(html)).not.toContain("aria-current");
    // Named by its visible label only.
    expect(trigger(html)).not.toContain("aria-label");
    state.pathname = "/marketplace/7";
    html = render(createElement(MobileNav, { items: navItemsFor("member") }));
    expect(current(html)).toEqual([]);
    expect(html).toContain('data-active="true"');
    // A programmatic cue, not only the colour: the button is current, and
    // its name says which entry ("More: Marketplace").
    expect(trigger(html)).toContain('aria-current="true"');
    expect(trigger(html)).toContain(`aria-label="${en.nav.more}: ${en.nav.marketplace}"`);
    expect(html).toContain(`>${en.nav.more}</span>`);
  });

  it("names the current sheet entry on the More tab in the UI language", () => {
    state.pathname = "/training/security-basics";
    const html = render(createElement(MobileNav, { items: navItemsFor("member") }), "de");
    expect(trigger(html)).toContain(`aria-label="${de.nav.more}: ${de.nav.training}"`);
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

describe("More sheet: open only on its route and below md", () => {
  /** A MediaQueryList stand-in: `matches` and the change listeners. */
  function stubMatchMedia(matches: boolean) {
    const listeners = new Set<EventListener>();
    const list = {
      matches,
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        if (type === "change") listeners.add(listener);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        if (type === "change") listeners.delete(listener);
      }),
    };
    const matchMedia = vi.fn((_query: string) => list);
    vi.stubGlobal("window", { matchMedia });
    return {
      matchMedia,
      listeners,
      /** The viewport crosses the query: `matches` flips, the listeners run. */
      resize(next: boolean) {
        list.matches = next;
        for (const listener of listeners) listener(new Event("change"));
      },
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays open on the route it was opened on, below md only", () => {
    expect(sheetStaysOpen("/kudos", "/kudos", false)).toBe(true);
    // A navigation from it closes it (the chosen entry's route rendered).
    expect(sheetStaysOpen("/kudos", "/polls", false)).toBe(false);
    // From md up the sheet is hidden: an open Radix dialog would keep the
    // page scroll-locked, inert and aria-hidden behind it.
    expect(sheetStaysOpen("/kudos", "/kudos", true)).toBe(false);
    expect(sheetStaysOpen(null, "/kudos", false)).toBe(false);
  });

  it("reads the viewport through one change listener on the md query", () => {
    const media = stubMatchMedia(false);
    const onChange = vi.fn();
    const unsubscribe = subscribeDesktop(onChange);
    expect(media.matchMedia).toHaveBeenCalledWith(DESKTOP_QUERY);
    expect(media.listeners.size).toBe(1);
    expect(isDesktopViewport()).toBe(false);

    // A phone rotated to landscape, a window widened past 768 px.
    media.resize(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(isDesktopViewport()).toBe(true);

    unsubscribe();
    expect(media.listeners.size).toBe(0);
    media.resize(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(isDesktopViewport()).toBe(false);
  });

  it("uses Tailwind's md, which tailwind.config.ts does not override", () => {
    expect(DESKTOP_QUERY).toBe(`(min-width: ${defaultTheme.screens.md})`);
    const config = readFileSync(join(__dirname, "..", "..", "..", "tailwind.config.ts"), "utf8");
    // The only `screens` there is the container's.
    expect(config.match(/\bscreens\s*:/g)).toHaveLength(1);
    expect(config).toMatch(/container:\s*{[^}]*screens:\s*{\s*"2xl"/);
  });

  it("renders closed in server markup (the server snapshot, no window)", () => {
    expect(typeof window).toBe("undefined");
    const html = render(createElement(MobileNav, { items: navItemsFor("member") }));
    expect(html).toMatch(/<button[^>]*aria-expanded="false"/);
    expect(html).not.toContain('role="dialog"');
  });
});

describe("MoreSheetLinks", () => {
  const more = (role: string) => navItemsFor(role).filter((item) => !item.mobilePrimary);

  it("lists every other section, /manage for an admin only", () => {
    const member = render(
      createElement(MoreSheetLinks, { items: more("member"), pathname: "/", onChoose() {} }),
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
      createElement(MoreSheetLinks, { items: more("admin_role"), pathname: "/", onChoose() {} }),
    );
    expect(links(admin).at(-1)).toBe("/manage");
    expect(admin).toContain(`>${en.nav.admin}<`);
  });

  it("marks the current section", () => {
    const html = render(
      createElement(MoreSheetLinks, {
        items: more("member"),
        pathname: "/kudos",
        onChoose() {},
      }),
    );
    expect(current(html)).toEqual(["/kudos"]);
  });

  it("reports the chosen entry", () => {
    const onChoose = vi.fn();
    // Called inside a render, so its hooks have the provider.
    let list: ReactNode = null;
    render(
      createElement(() => {
        list = MoreSheetLinks({ items: more("member"), pathname: "/", onChoose });
        return null;
      }),
    );
    const link = elements(list).find((el) => el.props.href === "/kudos");
    (link?.props.onClick as () => void)();
    expect(onChoose).toHaveBeenCalledWith("/kudos");
  });
});

describe("pending feedback (UI05)", () => {
  const pendingDots = (html: string) => html.match(/data-pending="true"/g)?.length ?? 0;

  it("shows no dot while no navigation runs", () => {
    const html = render(createElement(MobileNav, { items: navItemsFor("member") }));
    expect(pendingDots(html)).toBe(0);
    expect(html).toContain('aria-hidden="true" class="h-1.5 w-1.5');
  });

  it("shows the dot in a pending tab, sidebar link and sheet entry", () => {
    state.pending = true;
    const tabs = render(createElement(MobileNav, { items: navItemsFor("member") }));
    expect(pendingDots(tabs)).toBe(5);
    const link = render(createElement(NavLink, { href: "/kudos", label: "Kudos", icon: "Award" }));
    expect(pendingDots(link)).toBe(1);
    expect(link).toMatch(/<span aria-hidden="true" data-pending="true" class="[^"]*animate-pulse/);
    const sheet = render(
      createElement(MoreSheetLinks, {
        items: navItemsFor("member").filter((item) => !item.mobilePrimary),
        pathname: "/",
        onChoose() {},
      }),
    );
    expect(pendingDots(sheet)).toBe(7);
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
