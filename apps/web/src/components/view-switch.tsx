import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ViewSwitchItem {
  href: string;
  active: boolean;
  icon: LucideIcon;
  text: string;
}

/**
 * A page's view switch (events: list and month; org chart: reporting lines
 * and departments): one link per view in a labelled group, the active one
 * with `aria-current="page"`. Links, so it works without JavaScript and the
 * URL is the state.
 */
export function ViewSwitch({ label, items }: { label: string; items: ViewSwitchItem[] }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-xl border p-0.5">
      {items.map(({ href, active, icon: Icon, text }) => (
        <Link
          key={href}
          href={href}
          aria-current={active ? "page" : undefined}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-sm font-medium transition-colors",
            "outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            active
              ? "bg-primary text-primary-foreground ring-1 ring-primary-text"
              : "text-muted-foreground hover:bg-muted",
          )}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
          {text}
        </Link>
      ))}
    </div>
  );
}
