import Link from "next/link";
import type { Route } from "next";
import { ArrowLeft, Building2, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * The page parts of /manage (server components): the header with the way
 * back and an optional action, and the explanation for a department head
 * without a department (deep-dive decision 06 §L2, §N1).
 */

export function ManagePageHeader({
  title,
  description,
  back = "/manage",
  backLabel,
  action,
}: {
  title: string;
  description?: string;
  /** Where the back link leads (the landing, or the area's list). */
  back?: Route;
  backLabel?: string;
  /** A primary link next to the title ("New announcement"). */
  action?: { href: Route; label: string };
}) {
  const t = useTranslations("manage.common");
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <Link
          href={back}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {backLabel ?? t("back")}
        </Link>
        <h1 className="mt-2 break-words text-3xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-muted-foreground">{description}</p> : null}
      </div>
      {action ? (
        <Link href={action.href} className={buttonVariants({ className: "shrink-0" })}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {action.label}
        </Link>
      ) : null}
    </header>
  );
}

/** A department head without a department authors nothing (§N1): why, instead of a list or form. */
export function NoDepartmentExplanation() {
  const t = useTranslations("manage.common.departmentAuthor");
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Building2 className="h-6 w-6" aria-hidden="true" />
        </div>
        <h2 className="font-medium">{t("noDepartmentTitle")}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">{t("noDepartmentHint")}</p>
      </CardContent>
    </Card>
  );
}
