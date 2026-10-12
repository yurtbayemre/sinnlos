import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The small muted label over a section of a list page ("Pinned", "Upcoming",
 * "Active", "Recent kudos", the analytics sections; UI08). It is the
 * section's heading, an h2 under the page's h1 by default, so the cards
 * below (CardTitle h3) sit in a correct outline; `as="p"` for an eyebrow
 * line above a real heading (LatestNews, QuickLinks).
 */
export function SectionLabel({
  icon: Icon,
  as: Tag = "h2",
  className,
  children,
}: {
  icon?: LucideIcon;
  as?: "h2" | "h3" | "p" | "div";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag
      className={cn("flex items-center gap-2 text-sm font-medium text-muted-foreground", className)}
    >
      {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
      {children}
    </Tag>
  );
}
