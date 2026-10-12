"use client";

import Link, { useLinkStatus } from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { isNavActive } from "@/lib/nav-config";
// The (server) sidebar can't pass component references across the RSC
// boundary — icons are addressed by name and resolved here on the client
// via the shared icon map.
import { ICONS, type IconName } from "@/components/icon-map";

export type NavIconName = IconName;

/**
 * Pending feedback of a navigation link (UI05): useLinkStatus is true from
 * the click until the new route renders, also where no loading.tsx
 * skeleton shows (a prefetched route, a slow Server Component). A pulsing
 * dot, faded in after a short delay so an instant navigation does not
 * flicker. It must render inside the <Link> it reports on; it is
 * decorative (the route's loading state is announced by RouteProgress).
 */
export function LinkPendingIndicator({ className }: { className?: string }) {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden="true"
      data-pending={pending ? "true" : undefined}
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-0 transition-opacity duration-150",
        pending && "animate-pulse opacity-100 delay-150",
        className,
      )}
    />
  );
}

/**
 * Sidebar navigation link with an animated active state and the pending
 * dot. Client component so it can read the current pathname.
 */
export function NavLink({ href, label, icon }: { href: Route; label: string; icon: NavIconName }) {
  const Icon = ICONS[icon];
  const pathname = usePathname();
  const active = isNavActive(pathname, href);

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
      <LinkPendingIndicator className="ml-auto" />
    </Link>
  );
}
