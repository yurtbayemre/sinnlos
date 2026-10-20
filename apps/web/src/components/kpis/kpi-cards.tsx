import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { TrendingUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { kpiPeriodLabel } from "@/lib/kpi-format";
import { loadKpis, type KpiView } from "@/lib/loaders/kpis";
import { isReadDenied } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { getViewer } from "@/lib/viewer";

/**
 * KPIs (v0.19, "Kennzahlen"): server components over the published KPIs.
 * A card shows the latest reported value, the period before, the year to
 * date (sums only) and bars of the last periods; a gap is "not reported",
 * never zero.
 */

export async function KpiCard({ kpi }: { kpi: KpiView }) {
  const [t, format, locale] = await Promise.all([
    getTranslations("kpis"),
    getFormatter(),
    getLocale(),
  ]);
  const { latest, previous, yearToDate, series } = kpi.summary;
  const amount = (value: number) => {
    const number = format.number(value, { maximumFractionDigits: 2 });
    return kpi.unit ? `${number} ${kpi.unit}` : number;
  };
  const label = (period: string, short = false) =>
    kpiPeriodLabel(period, kpi.period, locale, short);
  const max = Math.max(0, ...series.map((point) => Math.abs(point.value ?? 0)));
  const first = series[0];
  const last = series[series.length - 1];
  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col gap-3 py-4">
        <div>
          <h3 className="font-medium">{kpi.name}</h3>
          {kpi.description && <p className="text-xs text-muted-foreground">{kpi.description}</p>}
        </div>
        {latest ? (
          <div>
            <p className="text-2xl font-semibold tabular-nums">{amount(latest.value)}</p>
            <p className="text-xs text-muted-foreground">{label(latest.period)}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("notReported")}</p>
        )}
        <div className="space-y-0.5 text-xs text-muted-foreground">
          {previous && (
            <p>
              {previous.value === null
                ? t("previousMissing", { period: label(previous.period) })
                : t("previous", { period: label(previous.period), value: amount(previous.value) })}
            </p>
          )}
          {kpi.aggregation === "sum" && yearToDate !== null && (
            <p>{t("yearToDate", { value: amount(yearToDate) })}</p>
          )}
        </div>
        {max > 0 && first && last && (
          <figure className="mt-auto">
            <div aria-hidden="true" className="flex h-16 items-end gap-1">
              {series.map((point) => (
                <div
                  key={point.period}
                  title={`${label(point.period)}: ${point.value === null ? t("missing") : amount(point.value)}`}
                  className="flex h-full flex-1 items-end"
                >
                  <div
                    className={cn(
                      "w-full rounded-sm",
                      point.value === null
                        ? "h-px bg-border"
                        : point.value < 0
                          ? "bg-destructive/60"
                          : "bg-primary/70",
                    )}
                    style={
                      point.value === null
                        ? undefined
                        : { height: `${Math.max(4, (Math.abs(point.value) / max) * 100)}%` }
                    }
                  />
                </div>
              ))}
            </div>
            <div
              aria-hidden="true"
              className="mt-1 flex justify-between text-[10px] text-muted-foreground"
            >
              <span>{label(first.period, true)}</span>
              <span>{label(last.period, true)}</span>
            </div>
            <figcaption className="sr-only">
              {t("chartLabel", { count: series.length })}:{" "}
              {series
                .map(
                  (point) =>
                    `${label(point.period)} ${point.value === null ? t("missing") : amount(point.value)}`,
                )
                .join("; ")}
            </figcaption>
          </figure>
        )}
      </CardContent>
    </Card>
  );
}

export function KpiGrid({ kpis }: { kpis: KpiView[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {kpis.map((kpi) => (
        <KpiCard key={kpi.documentId} kpi={kpi} />
      ))}
    </div>
  );
}

/** A department page's KPIs; nothing when it has none (or the viewer may not read them). */
export async function KpisSection({ department }: { department: string }) {
  const viewer = await getViewer();
  if (isReadDenied(viewer.role, "kpis")) return null;
  const t = await getTranslations("kpis");
  const view = await loadKpis();
  const kpis = view.kpis.filter((kpi) => kpi.department?.slug === department);
  if (!view.failed && kpis.length === 0) return null;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <SectionLabel icon={TrendingUp}>{t("title")}</SectionLabel>
        <Link href="/kpis" className="text-sm font-medium text-primary hover:underline">
          {t("viewAll")}
        </Link>
      </div>
      {view.failed ? (
        <p className="text-sm text-muted-foreground">{t("loadFailed")}</p>
      ) : (
        <KpiGrid kpis={kpis} />
      )}
    </section>
  );
}
