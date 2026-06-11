import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Friendly empty state with an icon, title and hint. Used wherever a
 * list can legitimately be empty so users get guidance, not a void.
 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-14 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Icon className="h-6 w-6" aria-hidden="true" />
        </div>
        <p className="font-medium">{title}</p>
        {hint ? <p className="max-w-sm text-sm text-muted-foreground">{hint}</p> : null}
        {children}
      </CardContent>
    </Card>
  );
}
