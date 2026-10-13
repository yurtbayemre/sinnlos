"use client";

import { useId, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Building2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { buttonVariants } from "@/components/ui/button";
import { AREA_PATH, type ManageArea } from "@/lib/manage/areas";
import { cn } from "@/lib/utils";
import { CheckboxField } from "./form-controls";

/** A titled section of an editor: an h2 under the page's h1 (the outline never skips). */
export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="space-y-4 rounded-2xl border bg-card p-4 sm:p-6"
    >
      <div className="space-y-1">
        <h2 id={headingId} className="text-base font-semibold">
          {title}
        </h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** The link back to the area's list, in the action bar. */
export function BackToList({ area }: { area: ManageArea }) {
  const t = useTranslations("manage.common.actions");
  return (
    <Link href={AREA_PATH[area]} className={cn(buttonVariants({ variant: "ghost" }))}>
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {t("backToList")}
    </Link>
  );
}

/**
 * The department picker of a department author (§L4, §N4): their
 * department, read-only, which the form sends pinned.
 */
export function PinnedDepartment({ name }: { name: string }) {
  const t = useTranslations("manage.common.departmentAuthor");
  return (
    <dl className="space-y-1.5">
      <dt className="text-sm font-medium">{t("department")}</dt>
      <dd className="inline-flex items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-sm">
        <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        {name}
      </dd>
      <dd className="text-xs text-muted-foreground">{t("departmentHint")}</dd>
    </dl>
  );
}

/** The pickers could not load (or not completely): the targeting is locked or may miss options. */
export function OptionsNotice({ failed, truncated }: { failed: boolean; truncated: boolean }) {
  const t = useTranslations("manage.common.targeting");
  if (!failed && !truncated) return null;
  return (
    <p
      role={failed ? "alert" : undefined}
      className="flex items-start gap-2 rounded-xl border border-amber-600/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {failed ? t("optionsFailed") : t("optionsTruncated")}
    </p>
  );
}

/**
 * Needs re-targeting (§N9): a department or team the item targeted was
 * deleted. A targeting change lowers the marker by itself; the checkbox
 * confirms the audience as it stands, which sends the targeting unchanged.
 */
export function RetargetNotice({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const t = useTranslations("manage.common.targeting");
  return (
    <div className="space-y-3 rounded-xl border border-amber-600/30 bg-amber-500/10 px-3 py-3">
      <p className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        {t("retargetNotice")}
      </p>
      <CheckboxField
        id="retarget-confirm"
        label={t("retargetConfirm")}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
    </div>
  );
}

/** The note on a department author's event (§N4): calendar-wide, notifies the department. */
export function EventVisibilityNote() {
  const t = useTranslations("manage.common.departmentAuthor");
  return (
    <p className="rounded-xl border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
      {t("eventVisibility")}
    </p>
  );
}
