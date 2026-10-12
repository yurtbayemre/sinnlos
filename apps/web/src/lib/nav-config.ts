/**
 * The one navigation of the app shell (FX30): the sidebar (md and up) and
 * the phone tab bar with its More sheet both map NAV_ITEMS, so every
 * section is reachable on every screen and a new section is added once.
 *
 * Which entries a viewer gets is decided on the server per request from the
 * role (navItemsFor, SH02 lib/roles.ts) and handed to the client nav as
 * plain data:
 *   - an entry with a read `capability` is hidden only when the viewer's
 *     role is a KNOWN role without that read (isReadDenied: guest has no
 *     announcements, departments, teams, kudos, marketplace or training). A
 *     role that could not be read keeps it: the page then asks the CMS,
 *     which decides, and an outage shows its error banner instead of a
 *     shrunken nav that the persistent layout would keep until a reload;
 *   - /manage follows capabilitiesFor(role).manage, fail-closed: admin_role
 *     only until batch 15 opens the shell to moderators and department
 *     authors (decision 06 §L1). It replaces the plan's `adminOnly` flag.
 * The nav is UX only: every page gates itself, and the CMS decides.
 */
import type { Route } from "next";
import type { Messages } from "next-intl";
import type { IconName } from "@/components/icon-map";
import { capabilitiesFor, isReadDenied, type ReadSection } from "@/lib/roles";

export type NavLabelKey = keyof Messages["nav"];

/** What an entry needs: the read of a section, or the /manage shell. */
export type NavCapability = ReadSection | "manage";

export interface NavItem {
  href: Route;
  /** The entry's label in the `nav` namespace of the message catalogs. */
  labelKey: NavLabelKey;
  /** A shorter label for the phone tab bar ("Home", "News"); labelKey otherwise. */
  mobileLabelKey?: NavLabelKey;
  icon: IconName;
  /** A tab of the phone tab bar; every other entry sits in its More sheet. */
  mobilePrimary?: boolean;
  capability?: NavCapability;
}

/** In display order; /manage is the reverse proxy's safe name for the admin area (/admin is Strapi). */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", labelKey: "dashboard", mobileLabelKey: "home", icon: "Home", mobilePrimary: true },
  { href: "/people", labelKey: "people", icon: "Contact", mobilePrimary: true },
  { href: "/events", labelKey: "events", icon: "Calendar", mobilePrimary: true },
  { href: "/wiki", labelKey: "wiki", icon: "BookOpen", mobilePrimary: true },
  { href: "/training", labelKey: "training", icon: "GraduationCap", capability: "training" },
  {
    href: "/departments",
    labelKey: "departments",
    icon: "Building2",
    capability: "departments",
  },
  { href: "/teams", labelKey: "teams", icon: "Users2", capability: "teams" },
  {
    href: "/announcements",
    labelKey: "announcements",
    mobileLabelKey: "news",
    icon: "Megaphone",
    mobilePrimary: true,
    capability: "announcements",
  },
  { href: "/kudos", labelKey: "kudos", icon: "Award", capability: "kudos" },
  {
    href: "/marketplace",
    labelKey: "marketplace",
    icon: "ShoppingBag",
    capability: "marketplace",
  },
  { href: "/polls", labelKey: "polls", icon: "BarChart3" },
  { href: "/documents", labelKey: "documents", icon: "FileText" },
  { href: "/manage", labelKey: "admin", icon: "Settings", capability: "manage" },
];

/**
 * Whether the entry `href` is the current section: the dashboard only on
 * "/" itself, every other entry on its path and below it, by whole path
 * segments ("/manage" is not active on "/marketplace", "/people" is active
 * on "/people/org-chart").
 */
export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The entries the viewer's role may use, in display order (see the header). */
export function navItemsFor(role: string | null | undefined): NavItem[] {
  const { manage } = capabilitiesFor(role);
  return NAV_ITEMS.filter((item) => {
    if (item.capability === undefined) return true;
    if (item.capability === "manage") return manage;
    return !isReadDenied(role, item.capability);
  });
}
