import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";

/**
 * The top bar at phone width: below `sm` the last button (Sign out, or the
 * Demo mode badge in DEMO_MODE) shows only its icon, square like the bar's
 * other h-9 controls, and keeps its label as the accessible name (sr-only).
 * With the label the controls needed more than a 360 px phone has: the
 * search button slid under the bell, and "Demo-Modus" pushed the page 6 px
 * sideways. From `sm` up the button shows the label alone, on one line, as
 * before (the layout itself is checked in a browser). The session,
 * the notification feed, the translations and the client controls are
 * mocked; DEMO_MODE is set per test.
 */
const state = vi.hoisted(() => ({ demo: false, locale: "en" as "en" | "de" }));

vi.mock("@/lib/config", () => ({
  get DEMO_MODE() {
    return state.demo;
  },
}));
vi.mock("@/lib/session", () => ({
  getSession: async () => ({
    user: { id: 7, name: "Casey Jones", email: "casey.jones@sinnlos.local", image: null },
    expires: "9999-12-31T23:59:59.999Z",
  }),
}));
vi.mock("@/lib/notification-actions", () => ({
  getNotifications: async () => ({ items: [], unread: 0 }),
}));
vi.mock("@/lib/auth-actions", () => ({ signOutAction: async () => undefined }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "auth" | "common" | "profile") => (key: string) =>
    ((state.locale === "en" ? en : de)[namespace] as Record<string, string>)[key],
}));
vi.mock("@/components/search-command", () => ({
  SearchCommand: () => createElement("button", { id: "search" }),
}));
vi.mock("@/components/theme-toggle", () => ({
  ThemeToggle: () => createElement("button", { id: "theme" }),
}));
vi.mock("@/components/locale-switcher", () => ({
  LocaleSwitcher: () => createElement("button", { id: "locale" }),
}));
vi.mock("@/components/notifications/live-notification-bell", () => ({
  LiveNotificationBell: () => createElement("button", { id: "bell" }),
}));
vi.mock("@/components/live/live-status", () => ({
  LiveStatus: () => createElement("div", { id: "live-status" }),
}));

const { Topbar } = await import("./topbar");

async function render({ demo = false, locale = "en" as "en" | "de" } = {}): Promise<string> {
  state.demo = demo;
  state.locale = locale;
  return renderToStaticMarkup(await Topbar());
}

/** The bar's last button: its attributes, its icon's and its label's classes, the label. */
function lastButton(html: string) {
  const header = html.slice(0, html.indexOf("</header>"));
  const markup = header.slice(header.lastIndexOf("<button"));
  const match =
    /^<button([^>]*)><svg([^>]*)>.*?<\/svg><span class="([^"]+)">([^<]+)<\/span><\/button>/s.exec(
      markup,
    );
  if (!match) throw new Error(`no icon button at the end of the bar: ${header}`);
  const [, attrs, svgAttrs, labelClass, label] = match;
  const classes = (source: string) => (/class="([^"]+)"/.exec(source)?.[1] ?? "").split(" ");
  return {
    attrs,
    buttonClass: classes(attrs),
    svgAttrs,
    svgClass: classes(svgAttrs),
    labelClass: labelClass.split(" "),
    label,
  };
}

afterEach(() => {
  state.demo = false;
  state.locale = "en";
});

describe("Topbar's last button at phone width", () => {
  it("collapses Sign out to its icon below sm, with the label as its name", async () => {
    const html = await render();
    expect(html).toContain("<form");
    const button = lastButton(html);
    expect(button.attrs).toContain('type="submit"');
    expect(button.label).toBe(en.auth.signOut);
    expect(button.svgClass).toEqual(expect.arrayContaining(["lucide-log-out", "sm:hidden"]));
    expect(button.svgAttrs).toContain('aria-hidden="true"');
    // not-sr-only resets white-space to normal: nowrap keeps the sm-up label
    // on one line, as the button had it.
    expect(button.labelClass).toEqual(["sr-only", "sm:not-sr-only", "sm:whitespace-nowrap"]);
    expect(html).not.toContain(en.auth.demoMode);
  });

  it("collapses the Demo mode badge the same way in DEMO_MODE", async () => {
    const html = await render({ demo: true });
    expect(html).not.toContain("<form");
    const button = lastButton(html);
    expect(button.attrs).toContain("disabled");
    expect(button.label).toBe(en.auth.demoMode);
    expect(button.svgClass).toEqual(expect.arrayContaining(["lucide-flask-conical", "sm:hidden"]));
    expect(button.labelClass).toEqual(["sr-only", "sm:not-sr-only", "sm:whitespace-nowrap"]);
    expect(html).not.toContain(en.auth.signOut);
  });

  it("is square like the bar's h-9 controls below sm and keeps its sm-up padding", async () => {
    for (const demo of [false, true]) {
      const { buttonClass } = lastButton(await render({ demo }));
      // h-9 from size "sm"; w-9 px-0 make it the bell's and the theme
      // toggle's square; from sm up w-auto px-3, the size "sm" padding.
      expect(buttonClass).toEqual(
        expect.arrayContaining(["h-9", "w-9", "px-0", "sm:w-auto", "sm:px-3"]),
      );
      expect(buttonClass).not.toContain("px-3");
    }
  });

  it("names the button in the UI language", async () => {
    expect(lastButton(await render({ locale: "de" })).label).toBe(de.auth.signOut);
    expect(lastButton(await render({ demo: true, locale: "de" })).label).toBe(de.auth.demoMode);
  });
});
