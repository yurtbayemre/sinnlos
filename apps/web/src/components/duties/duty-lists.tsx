import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { CalendarClock } from "lucide-react";
import { dutyShiftsAt, dutyShiftsBetween } from "@sinnlos/domain";
import { Card, CardContent } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { appTimeZone } from "@/lib/app-time-zone";
import { loadDuties, type DutiesView, type DutyPlanView } from "@/lib/loaders/duties";
import { addDaysToKey, zonedDateKey, zonedDayStart } from "@/lib/plain-date";
import { isReadDenied } from "@/lib/roles";
import { isOff } from "@/lib/switches";
import { getViewer } from "@/lib/viewer";

/**
 * Who is on duty (v0.18, "Zuständigkeiten"): server components over the
 * published duty plans. Times are APP_TIME_ZONE wall times (next-intl's
 * request time zone).
 */

type People = DutiesView["people"];

/** "14:00" on `day`, else "Mo 06:00". */
async function timeLabel(instant: string, day: string) {
  const format = await getFormatter();
  const date = new Date(instant);
  return zonedDateKey(instant, appTimeZone()) === day
    ? format.dateTime(date, { hour: "2-digit", minute: "2-digit" })
    : format.dateTime(date, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function PlanName({ plan }: { plan: DutyPlanView }) {
  const meta = [plan.department?.name, plan.note].filter(Boolean).join(" · ");
  return (
    <div className="min-w-0">
      <p className="font-medium">{plan.name}</p>
      {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
    </div>
  );
}

async function Person({ userId, people }: { userId: number; people: People }) {
  const t = await getTranslations("duties");
  const person = people[userId];
  return (
    <>
      <span className="font-medium">
        {person?.former ? t("formerPerson") : (person?.name ?? t("unknownPerson"))}
      </span>
      {person?.phone && (
        <>
          {" · "}
          <a href={`tel:${person.phone}`} className="underline-offset-2 hover:underline">
            {person.phone}
          </a>
        </>
      )}
    </>
  );
}

/** Each plan with the people on duty at `now`, or "not staffed". */
export async function DutyNowList({
  plans,
  people,
  now,
}: {
  plans: DutyPlanView[];
  people: People;
  now: Date;
}) {
  const t = await getTranslations("duties");
  const today = zonedDateKey(now, appTimeZone());
  return (
    <ul className="divide-y">
      {await Promise.all(
        plans.map(async (plan) => {
          const onDuty = dutyShiftsAt(plan.shifts, now);
          return (
            <li
              key={plan.documentId}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3"
            >
              <PlanName plan={plan} />
              <div className="space-y-0.5 text-sm sm:text-right">
                {onDuty.length === 0 ? (
                  <p className="italic text-muted-foreground">{t("notStaffed")}</p>
                ) : (
                  await Promise.all(
                    onDuty.map(async (shift, i) => (
                      <p key={i}>
                        <Person userId={shift.userId} people={people} />{" "}
                        <span className="text-muted-foreground">
                          {t("until", { time: await timeLabel(shift.endsAt, today) })}
                        </span>
                      </p>
                    )),
                  )
                )}
              </div>
            </li>
          );
        }),
      )}
    </ul>
  );
}

/** The shifts of calendar day `day` per plan; plans without one are left out. */
export async function DutyDayList({
  plans,
  people,
  day,
}: {
  plans: DutyPlanView[];
  people: People;
  day: string;
}) {
  const t = await getTranslations("duties");
  const timeZone = appTimeZone();
  const from = zonedDayStart(day, timeZone);
  const to = zonedDayStart(addDaysToKey(day, 1), timeZone);
  const rows = plans
    .map((plan) => ({ plan, shifts: dutyShiftsBetween(plan.shifts, from, to) }))
    .filter((row) => row.shifts.length > 0);
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t("noShifts")}</p>;
  return (
    <Card>
      <CardContent className="py-1">
        <ul className="divide-y">
          {await Promise.all(
            rows.map(async ({ plan, shifts }) => (
              <li
                key={plan.documentId}
                className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3"
              >
                <PlanName plan={plan} />
                <div className="space-y-0.5 text-sm sm:text-right">
                  {await Promise.all(
                    shifts.map(async (shift, i) => (
                      <p key={i}>
                        <span className="tabular-nums text-muted-foreground">
                          {await timeLabel(shift.startsAt, day)}–
                          {await timeLabel(shift.endsAt, day)}
                        </span>{" "}
                        <Person userId={shift.userId} people={people} />
                      </p>
                    )),
                  )}
                </div>
              </li>
            )),
          )}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * "On duty now" on the dashboard and a department page: nothing for a role
 * without the read or while no plan is published; a failed read says so.
 */
export async function DutiesNowSection({ department }: { department?: string }) {
  // Duty plans switched off (FEATURES_OFF, v0.28): no section and no read.
  if (isOff("duty-plans")) return null;
  const viewer = await getViewer();
  if (isReadDenied(viewer.role, "duties")) return null;
  const t = await getTranslations("duties");
  const view = await loadDuties();
  const plans = department
    ? view.plans.filter((plan) => plan.department?.slug === department)
    : view.plans;
  if (!view.failed && plans.length === 0) return null;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <SectionLabel as="p" icon={CalendarClock}>
            {t("title")}
          </SectionLabel>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">{t("now")}</h2>
        </div>
        <Link href="/duties" className="text-sm font-medium text-primary hover:underline">
          {t("viewAll")}
        </Link>
      </div>
      <Card>
        <CardContent className="py-1">
          {view.failed ? (
            <p className="py-3 text-sm text-muted-foreground">{t("loadFailed")}</p>
          ) : (
            <DutyNowList plans={plans} people={view.people} now={new Date()} />
          )}
        </CardContent>
      </Card>
    </section>
  );
}
