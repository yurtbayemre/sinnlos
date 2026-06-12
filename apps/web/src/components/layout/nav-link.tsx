"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Award,
  BarChart3,
  BookOpen,
  Building2,
  Calendar,
  Contact,
  FileText,
  Home,
  Megaphone,
  Settings,
  Users2,
} from "lucide-react";
import { cn } from "@/lib/utils";

// The (server) sidebar can't pass component references across the RSC
// boundary — icons are addressed by name and resolved here on the client.
const ICONS = {
  Award,
  BarChart3,
  BookOpen,
  Building2,
  Calendar,
  Contact,
  FileText,
  Home,
  Megaphone,
  Settings,
  Users2,
} as const;

export type NavIconName = keyof typeof ICONS;

/**
 * Sidebar navigation link with an animated active state. Client
 * component so it can read the current pathname.
 */
export function NavLink({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: NavIconName;
}) {
  const Icon = ICONS[icon];
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm outline-none transition-colors duration-150",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        active
          ? "bg-primary/10 font-medium text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary transition-all duration-200",
          active ? "opacity-100 scale-y-100" : "opacity-0 scale-y-50",
        )}
      />
      <Icon
        aria-hidden="true"
        className={cn(
          "h-4 w-4 transition-transform duration-150",
          !active && "group-hover:scale-110",
        )}
      />
      {label}
    </Link>
  );
}
