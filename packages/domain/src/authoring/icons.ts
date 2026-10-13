/**
 * The icon names a v2 author may store (deep-dive decision 06 §B1.3; batch
 * 15 plan S14, contract K7): quick-link `icon` today, wiki-space `icon`
 * from batch 16. The web renders an icon by name through its icon map
 * (apps/web/src/components/icon-map.ts ICONS); the cms allowlist accepts
 * only these names, so nothing it stores fails to render. The web's
 * icon-map.test.ts pins that ICONS has every key listed here (15C), so a
 * name can join this list only together with its component.
 *
 * Names, not components: the package has no dependency on lucide-react.
 */
export const ICON_KEYS = [
  "Award",
  "BarChart3",
  "BookOpen",
  "Briefcase",
  "Building2",
  "Calendar",
  "Code",
  "Contact",
  "ExternalLink",
  "FileText",
  "Globe",
  "GraduationCap",
  "Heart",
  "Home",
  "LifeBuoy",
  "Link2",
  "Megaphone",
  "Settings",
  "ShoppingBag",
  "Ticket",
  "Users2",
  "Wallet",
  "Wrench",
] as const;

export type IconKey = (typeof ICON_KEYS)[number];

/** True for one of ICON_KEYS (exact, case-sensitive). */
export function isIconKey(value: unknown): value is IconKey {
  return (ICON_KEYS as readonly unknown[]).includes(value);
}
