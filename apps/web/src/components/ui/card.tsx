import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * The card primitives (vendored from shadcn/ui and adapted; there is no
 * components.json on purpose, the kit carries local choices such as
 * rounded-2xl). React 19: `ref` is a plain prop, no forwardRef (UI06).
 */

/**
 * A card. `interactive` is for a card that is (or sits inside) a link or a
 * button: it adds the hover shadow, which a static card no longer shows
 * (it used to be on every card and suggested a click target where there
 * was none). Clickable cards that also lift on hover add `card-lift`.
 */
function Card({
  className,
  interactive = false,
  ...props
}: ComponentProps<"div"> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-2xl border bg-card text-card-foreground shadow-sm",
        interactive && "transition hover:shadow-md",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />;
}

/** The heading elements a card title may render as. */
export type CardTitleLevel = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

/**
 * The card's title, an h3 unless `as` says otherwise. Pick the level from
 * the page outline: a card directly under the page's h1 is an h2, a card
 * inside an h2 section an h3, so the outline never skips a level (the
 * title used to be an h3 everywhere, and pages jumped from h1 to h3).
 */
function CardTitle({
  as: Heading = "h3",
  className,
  ...props
}: ComponentProps<"h3"> & { as?: CardTitleLevel }) {
  return (
    <Heading className={cn("font-semibold leading-none tracking-tight", className)} {...props} />
  );
}

function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("p-6 pt-0", className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent };
