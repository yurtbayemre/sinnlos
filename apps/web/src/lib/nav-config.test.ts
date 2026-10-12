import { describe, expect, it } from "vitest";
import de from "../../messages/de.json";
import en from "../../messages/en.json";
import { ICONS } from "@/components/icon-map";
import { isNavActive, NAV_ITEMS, navItemsFor, type NavItem } from "./nav-config";

/**
 * FX30: one nav config for the sidebar and the phone nav. isNavActive
 * matches by whole path segments; every label exists in both catalogs;
 * navItemsFor hides what the role cannot use (SH02).
 */
describe("isNavActive", () => {
  it("marks the dashboard on the root only", () => {
    expect(isNavActive("/", "/")).toBe(true);
    for (const pathname of ["/people", "/manage", "/wiki/it/setup"]) {
      expect(isNavActive(pathname, "/"), pathname).toBe(false);
    }
  });

  it("marks a section on its path and below it", () => {
    expect(isNavActive("/people", "/people")).toBe(true);
    expect(isNavActive("/people/org-chart", "/people")).toBe(true);
    expect(isNavActive("/wiki/it/setup", "/wiki")).toBe(true);
    expect(isNavActive("/marketplace/7/edit", "/marketplace")).toBe(true);
  });

  it("matches whole segments, not string prefixes", () => {
    expect(isNavActive("/marketplace", "/manage")).toBe(false);
    expect(isNavActive("/manage", "/marketplace")).toBe(false);
    expect(isNavActive("/manage/training", "/training")).toBe(false);
    expect(isNavActive("/manage/training", "/manage")).toBe(true);
    expect(isNavActive("/peoplex", "/people")).toBe(false);
    expect(isNavActive("/teamsters", "/teams")).toBe(false);
  });

  it("marks exactly one entry for every section page", () => {
    const pages = [
      "/",
      "/people/42",
      "/events",
      "/wiki/it/setup",
      "/training/security/l1",
      "/departments/engineering",
      "/teams/frontend",
      "/announcements",
      "/kudos",
      "/marketplace/new",
      "/polls/new",
      "/documents",
      "/manage/acknowledgements",
    ];
    for (const pathname of pages) {
      const active = NAV_ITEMS.filter((item) => isNavActive(pathname, item.href));
      expect(active.length, pathname).toBe(1);
    }
  });
});

describe("NAV_ITEMS", () => {
  const labelKeys = (item: NavItem) => [item.labelKey, item.mobileLabelKey].filter(Boolean);

  it("has a label for every entry in both catalogs", () => {
    for (const item of NAV_ITEMS) {
      for (const key of labelKeys(item) as string[]) {
        expect(Object.keys(en.nav), `${item.href} ${key} (en)`).toContain(key);
        expect(Object.keys(de.nav), `${item.href} ${key} (de)`).toContain(key);
      }
    }
    // The phone nav's own labels.
    for (const key of ["more", "moreSections"]) {
      expect(Object.keys(en.nav)).toContain(key);
      expect(Object.keys(de.nav)).toContain(key);
    }
  });

  it("has unique hrefs and known icons", () => {
    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const item of NAV_ITEMS) expect(Object.keys(ICONS), item.href).toContain(item.icon);
  });

  it("keeps the phone tab bar to five tabs besides More", () => {
    const primary = NAV_ITEMS.filter((item) => item.mobilePrimary).map((item) => item.href);
    expect(primary).toEqual(["/", "/people", "/events", "/wiki", "/announcements"]);
  });
});

describe("navItemsFor", () => {
  const hrefs = (role: string | null) => navItemsFor(role).map((item) => item.href);
  const EVERYONE = ["/", "/people", "/events", "/wiki", "/polls", "/documents"];
  const READ_GATED = [
    "/training",
    "/departments",
    "/teams",
    "/announcements",
    "/kudos",
    "/marketplace",
  ];

  it("gives an admin every entry, /manage included", () => {
    expect(hrefs("admin_role")).toEqual(NAV_ITEMS.map((item) => item.href));
  });

  it.each(["editor", "department_head", "team_lead", "member", "authenticated"])(
    "gives %s every section but /manage",
    (role) => {
      expect(hrefs(role)).toEqual(
        NAV_ITEMS.map((item) => item.href).filter((href) => href !== "/manage"),
      );
    },
  );

  it("hides from a guest the sections it cannot read", () => {
    expect(hrefs("guest").sort()).toEqual([...EVERYONE].sort());
  });

  it.each([null, "", "Admin_role", "intern"])(
    "keeps the read sections for an unreadable or unknown role %j, never /manage",
    (role) => {
      expect(hrefs(role).sort()).toEqual([...EVERYONE, ...READ_GATED].sort());
    },
  );
});
