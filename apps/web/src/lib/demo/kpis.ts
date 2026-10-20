import { addKpiPeriods, kpiPeriodStart } from "@sinnlos/domain";
import type { Kpi } from "@/lib/types";
import type { DemoClock } from "./clock";

/** Three published KPIs (v0.19): monthly cubic metres, quarterly orders, a company-wide level. */
export function demoKpis(clock: DemoClock) {
  const engineering = {
    id: 1,
    documentId: "demodepartment0000000001",
    name: "Engineering",
    slug: "engineering",
  };
  const month = kpiPeriodStart(clock.dateOnly(0), "month");
  const quarter = kpiPeriodStart(clock.dateOnly(0), "quarter");
  // The current period is still open: the series ends one period before it.
  const series = (start: string, period: "month" | "quarter", numbers: number[]) =>
    Object.fromEntries(
      numbers.map((value, i) => [addKpiPeriods(start, period, i - numbers.length), value]),
    );
  const kpis: Kpi[] = [
    {
      id: 1,
      documentId: "demokpi00000000000000001",
      name: "Verladene Kubikmeter",
      unit: "m³",
      description: "Be- und Entladung an allen Rampen",
      period: "month",
      aggregation: "sum",
      values: series(
        month,
        "month",
        [1180, 1240, 990, 1310, 1275, 1420, 1388, 1502, 1460, 1395, 1530],
      ),
      department: engineering,
    },
    {
      id: 2,
      documentId: "demokpi00000000000000002",
      name: "Abgeschlossene Werkstattaufträge",
      unit: "Aufträge",
      description: null,
      period: "quarter",
      aggregation: "sum",
      values: series(quarter, "quarter", [182, 205, 197, 221]),
      department: engineering,
    },
    {
      id: 3,
      documentId: "demokpi00000000000000003",
      name: "Gereinigte Artikel im Bestand",
      unit: "Artikel",
      description: "Stand am Monatsende",
      period: "month",
      aggregation: "last",
      values: series(month, "month", [8200, 8350, 8410, 8600, 8720, 8805]),
      department: null,
    },
  ];
  return { kpis };
}
