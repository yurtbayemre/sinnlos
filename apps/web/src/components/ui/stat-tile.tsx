import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Count } from "@/lib/loaders/count";
import { cn } from "@/lib/utils";

/**
 * An icon tile (UI08): the dashboard's counts, the /manage link tiles and
 * the analytics numbers, which used to be three hand-built copies.
 *  - size "md" (dashboard, /manage): the icon on a primary tint; a stat
 *    shows `label` above `value`, a link tile `label` above `description`.
 *  - size "sm" (analytics): the icon in `iconClassName`'s colour on the
 *    muted fill, `value` above a small `label`.
 * With `href` the whole tile is one link (focus ring on the link, the
 * card interactive and lifting on hover; its text is the link's name).
 */
export function StatTile({
  icon: Icon,
  label,
  value,
  description,
  href,
  size = "md",
  iconClassName,
}: {
  icon: LucideIcon;
  label: ReactNode;
  /** A number, StatCount, a placeholder while it streams; omitted on a link tile. */
  value?: ReactNode;
  /** The second line of a link tile (instead of a value). */
  description?: ReactNode;
  href?: Route;
  size?: "md" | "sm";
  /** The icon's colour on the muted fill ("sm"). */
  iconClassName?: string;
}) {
  const small = size === "sm";
  const tile = (
    <Card interactive={!!href} className={cn(href && "card-lift h-full")}>
      <CardContent className={cn("flex items-center gap-4", small ? "p-4" : "p-6")}>
        <div
          className={cn(
            "flex shrink-0 items-center justify-center rounded-xl",
            small ? "h-10 w-10 bg-muted" : "h-11 w-11 bg-primary/10 text-primary",
            href && "transition-transform duration-200 group-hover:scale-110",
            iconClassName,
          )}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          {small ? (
            <>
              <div className="text-2xl font-semibold tracking-tight">{value}</div>
              <div className="text-xs text-muted-foreground">{label}</div>
            </>
          ) : value !== undefined ? (
            <>
              <div className="text-sm text-muted-foreground">{label}</div>
              <div className="text-2xl font-semibold tracking-tight">{value}</div>
            </>
          ) : (
            <>
              <div className="font-medium">{label}</div>
              {description ? (
                <div className="text-sm text-muted-foreground">{description}</div>
              ) : null}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
  return href ? (
    <Link href={href} className="focus-card group block">
      {tile}
    </Link>
  ) : (
    tile
  );
}

/**
 * A count as a tile shows it (WD03, lib/loaders/count.ts): the number;
 * "N+" when its list walk stopped at the safety cap; "–" when the read
 * failed (never a misleading 0), which a screen reader hears as
 * `unknownLabel`.
 */
export function StatCount({ count, unknownLabel }: { count: Count; unknownLabel: string }) {
  if (count.value === null) {
    return (
      <>
        <span aria-hidden="true">–</span>
        <span className="sr-only">{unknownLabel}</span>
      </>
    );
  }
  return <>{count.truncated ? `${count.value}+` : count.value}</>;
}

/** The `value` of a tile whose count still streams in (its Suspense fallback). */
export function StatValueSkeleton() {
  return <Skeleton aria-hidden="true" className="mt-1 h-7 w-12 rounded-md" />;
}
