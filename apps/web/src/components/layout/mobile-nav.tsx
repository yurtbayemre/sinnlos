"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, Calendar, Contact, Home, Megaphone } from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { href: "/", label: "Home", icon: Home },
  { href: "/people", label: "People", icon: Contact },
  { href: "/events", label: "Events", icon: Calendar },
  { href: "/wiki", label: "Wiki", icon: BookOpen },
  { href: "/announcements", label: "News", icon: Megaphone },
] as const;

/**
 * Bottom tab bar shown on small screens, where the sidebar is hidden.
 * Mirrors the sidebar's main destinations.
 */
export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/90 backdrop-blur md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="grid grid-cols-5">
        {items.map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex flex-col items-center gap-1 py-2 text-[11px] outline-none transition-colors",
                "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                active ? "text-primary" : "text-muted-foreground",
              )}
            >
              <item.icon
                aria-hidden="true"
                className={cn(
                  "h-5 w-5 transition-transform duration-150",
                  active && "scale-110",
                )}
              />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
