import Link from "next/link";
import type { Route } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { CalendarClock } from "lucide-react";
import { DutyDayList, DutyNowList } from "@/components/duties/duty-lists";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { SectionUnavailablePage } from "@/components/section-unavailable";
import { Card, CardContent } from "@/components/ui/card";
import { appTimeZone } from "@/lib/app-time-zone";
import { loadDuties } from "@/lib/loaders/duties";
import { addDaysToKey, zonedDateKey, zonedDayStart } from "@/lib/plain-date";
import { isReadDenied } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { getViewer } from "@/lib/viewer";

export async function generateMetadata() {
  const t = await getTranslations("duties");
  return { title: t("title") };
}

/** Days the page lists, today included. */
const DAYS = 7;

/**
 * Who is on duty (v0.18, "Zuständigkeiten"): now, then today and the next
 * six days in APP_TIME_ZONE, optionally for one department (`?department=`
 * slug). Every staff role reads; guests get the explanation instead.
 */
export default async function DutiesPage({
  searchParams,
}: {
  searchParams: Promise<{ department?: string | string[] }>;
}) {
  const t = await getTranslations("duties");
  const viewer = await getViewer();
  if (isReadDenied(viewer.role, "duties")) {
    return <SectionUnavailablePage title={t("title")} description={t("description")} />;
  }
  const [{ department: raw }, view, format] = await Promise.all([
    searchParams,
    loadDuties(),
    getFormatter(),
  ]);
  const department = typeof raw === "string" ? raw : undefined;
  const timeZone = appTimeZone();
  const now = new Date();
  const today = zonedDateKey(now, timeZone);
  const departments = [
    ...new Map(
      view.plans.flatMap((plan) =>
        plan.department ? [[plan.department.slug, plan.department]] : [],
      ),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const plans = department
    ? view.plans.filter((plan) => plan.department?.slug === department)
    : view.plans;
  const chip = (href: Route, label: string, active: boolean) => (
    <Link
      key={href}
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-full border px-3 py-1 text-sm transition-colors",
        active ? "border-primary-text bg-primary text-primary-foreground" : "hover:bg-accent",
      )}
    >
      {label}
    </Link>
  );

  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("description")} />
      {view.failed && <FetchErrorBanner />}
      {!view.failed && view.plans.length === 0 ? (
        <EmptyState icon={CalendarClock} title={t("empty")} />
      ) : (
        <>
          {departments.length > 1 && (
            <nav aria-label={t("filter")} className="flex flex-wrap gap-2">
              {chip("/duties", t("allDepartments"), !department)}
              {departments.map((d) =>
                chip(
                  `/duties?department=${encodeURIComponent(d.slug)}` as Route,
                  d.name,
                  d.slug === department,
                ),
              )}
            </nav>
          )}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold tracking-tight">{t("now")}</h2>
            <Card>
              <CardContent className="py-1">
                <DutyNowList plans={plans} people={view.people} now={now} />
              </CardContent>
            </Card>
          </section>
          {Array.from({ length: DAYS }, (_, i) => addDaysToKey(today, i)).map((day, i) => (
            <section key={day} className="space-y-3">
              <h2 className="text-lg font-semibold tracking-tight">
                {i === 0
                  ? t("today")
                  : format.dateTime(zonedDayStart(day, timeZone), {
                      weekday: "long",
                      day: "numeric",
                      month: "long",
                    })}
              </h2>
              <DutyDayList plans={plans} people={view.people} day={day} />
            </section>
          ))}
        </>
      )}
    </div>
  );
}
