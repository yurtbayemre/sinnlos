import {
  Award,
  BarChart3,
  BookOpen,
  Briefcase,
  Building2,
  Calendar,
  Contact,
  ExternalLink,
  FileText,
  Globe,
  GraduationCap,
  Home,
  LifeBuoy,
  Link2,
  Megaphone,
  Settings,
  ShoppingBag,
  Ticket,
  Users2,
  Wallet,
  Wrench,
} from "lucide-react";

/**
 * Icons addressed by NAME so server components can hand them across the
 * RSC boundary as plain strings (component references are not
 * serializable — see nav-link.tsx / sidebar.tsx). This module carries no
 * "use client" directive on purpose: client components (NavLink) resolve
 * names in the browser bundle, server components (QuickLinks widget)
 * resolve them during SSR. CMS-managed content (quick-link.icon) stores
 * these names as strings.
 */
export const ICONS = {
  Award,
  BarChart3,
  BookOpen,
  Briefcase,
  Building2,
  Calendar,
  Contact,
  ExternalLink,
  FileText,
  Globe,
  GraduationCap,
  Home,
  LifeBuoy,
  Link2,
  Megaphone,
  Settings,
  ShoppingBag,
  Ticket,
  Users2,
  Wallet,
  Wrench,
} as const;

export type IconName = keyof typeof ICONS;

/**
 * Own keys only (FX27): `name in ICONS` also accepted inherited keys, so a
 * quick link whose icon is "constructor" rendered Object as a component and
 * crashed the dashboard.
 */
export function isIconName(name: string | null | undefined): name is IconName {
  return typeof name === "string" && Object.hasOwn(ICONS, name);
}
