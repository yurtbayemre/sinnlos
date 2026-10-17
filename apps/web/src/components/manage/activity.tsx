import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type { ActivityListRow, AuthoringPagination } from "@sinnlos/domain";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { formatInstant, SHORT_DAY } from "@/lib/date-format";
import {
  ACTIVITY_CLASSES,
  ACTIVITY_KINDS,
  ACTIVITY_TARGETS,
  activityHref,
  type ActivityFilters,
} from "@/lib/loaders/manage/activity";
import { inputClass } from "./form-controls";

/** URL-based filters work without JavaScript; no actor directory or mutation is needed. */
export function ActivityFiltersForm({
  filters,
  timeZone,
  invalid,
}: {
  filters: ActivityFilters;
  timeZone: string;
  invalid: boolean;
}) {
  const t = useTranslations("manage.activity");
  const tf = useTranslations("manage.common.fields");
  return (
    <form
      method="get"
      action="/manage/activity"
      className="space-y-4"
      aria-label={t("filters")}
      aria-describedby={invalid ? "activity-filter-error" : undefined}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <label htmlFor="activity-target" className="block text-sm font-medium">
            {t("target")}
          </label>
          <select
            id="activity-target"
            name="targetUid"
            defaultValue={filters.targetUid}
            className={inputClass}
          >
            <option value="">{t("all")}</option>
            {Object.entries(ACTIVITY_TARGETS).map(([uid, key]) => (
              <option key={uid} value={uid}>
                {t(`targets.${key}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="activity-kind" className="block text-sm font-medium">
            {t("actorKind")}
          </label>
          <select
            id="activity-kind"
            name="actorKind"
            defaultValue={filters.actorKind}
            className={inputClass}
          >
            <option value="">{t("all")}</option>
            {ACTIVITY_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`kinds.${kind}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="activity-actor" className="block text-sm font-medium">
            {t("actorId")}
          </label>
          <input
            id="activity-actor"
            name="actorId"
            type="number"
            min="1"
            max="2147483647"
            step="1"
            defaultValue={filters.actorId}
            aria-describedby="activity-actor-hint"
            className={inputClass}
          />
          <p id="activity-actor-hint" className="text-xs text-muted-foreground">
            {t("actorHint")}
          </p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="activity-class" className="block text-sm font-medium">
            {t("actorClass")}
          </label>
          <select
            id="activity-class"
            name="actorClass"
            defaultValue={filters.actorClass}
            className={inputClass}
          >
            <option value="">{t("all")}</option>
            {ACTIVITY_CLASSES.map((value) => (
              <option key={value} value={value}>
                {t(`classes.${value}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {(["from", "to"] as const).map((bound) => (
          <fieldset key={bound} className="space-y-1.5" aria-describedby={`activity-${bound}-zone`}>
            <legend className="text-sm font-medium">{t(bound)}</legend>
            <div className="flex gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <label
                  htmlFor={`activity-${bound}-date`}
                  className="block text-xs text-muted-foreground"
                >
                  {tf("date")}
                </label>
                <input
                  id={`activity-${bound}-date`}
                  type="date"
                  name={`${bound}Date`}
                  aria-describedby={`activity-${bound}-zone`}
                  defaultValue={filters[`${bound}Date`]}
                  className={inputClass}
                />
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <label
                  htmlFor={`activity-${bound}-time`}
                  className="block text-xs text-muted-foreground"
                >
                  {tf("time")}
                </label>
                <input
                  id={`activity-${bound}-time`}
                  type="time"
                  name={`${bound}Time`}
                  aria-describedby={`activity-${bound}-zone`}
                  defaultValue={filters[`${bound}Time`]}
                  className={inputClass}
                />
              </div>
            </div>
            <p id={`activity-${bound}-zone`} className="text-xs text-muted-foreground">
              {tf("timeZone", { zone: timeZone })}
            </p>
          </fieldset>
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        <button type="submit" className={buttonVariants({ size: "sm" })}>
          {t("apply")}
        </button>
        <Link
          href="/manage/activity"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          {t("reset")}
        </Link>
      </div>
    </form>
  );
}

export function ActivityList({ rows }: { rows: ActivityListRow[] }) {
  const t = useTranslations("manage.activity");
  const format = useFormatter();
  return (
    <ul className="space-y-4" aria-label={t("title")}>
      {rows.map((row) => (
        <li key={row.id}>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle
                as="h2"
                className="flex flex-wrap items-center justify-between gap-2 text-base"
              >
                <span>
                  {t(`actions.${row.action}`)} · {t(`targets.${ACTIVITY_TARGETS[row.targetUid]}`)}
                </span>
                <time
                  dateTime={row.createdAt}
                  className="text-sm font-normal text-muted-foreground"
                >
                  {formatInstant(format, row.createdAt, {
                    ...SHORT_DAY,
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="break-words font-medium">
                {row.actor.displayName}{" "}
                <span className="font-normal text-muted-foreground">
                  ({t(`kinds.${row.actor.kind}`)}
                  {row.actor.id !== null ? ` #${row.actor.id}` : ""}
                  {row.actor.class ? ` · ${t(`classes.${row.actor.class}`)}` : ""})
                </span>
              </p>
              <p className="break-all text-muted-foreground">
                {t("contentId", { id: row.targetDocumentId })}
                {row.revision !== null
                  ? ` · ${t("revision", { version: row.revision })}`
                  : ""} · {t(`sources.${row.source}`)}
              </p>
              {row.keys.length > 0 && (
                <p className="break-words">{t("changedFields", { fields: row.keys.join(", ") })}</p>
              )}
              {row.detail && <p className="break-words text-muted-foreground">{row.detail}</p>}
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

export function ActivityPagination({
  filters,
  pagination,
}: {
  filters: ActivityFilters;
  pagination: AuthoringPagination;
}) {
  const t = useTranslations("manage.common.list");
  const { page, pageCount, total } = pagination;
  return (
    <nav
      aria-label={t("pagination")}
      className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"
    >
      <span>{t("total", { count: total })}</span>
      {(pageCount > 1 || page > 1) && (
        <div className="flex items-center gap-2">
          {page > 1 && (
            <Link
              href={activityHref(filters, page - 1)}
              rel="prev"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              {t("previous")}
            </Link>
          )}
          <span aria-current="page">{t("page", { page, pageCount })}</span>
          {page < pageCount && page < 10_000 && (
            <Link
              href={activityHref(filters, page + 1)}
              rel="next"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              {t("next")}
              <ChevronRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          )}
        </div>
      )}
    </nav>
  );
}
