/**
 * KPIs (v0.19, "Kennzahlen"). Every staff role reads the published KPIs
 * (published-only; guests hold no grant). Uncached like the duty plans:
 * a value typed in shows on the next read.
 */
import { walkAllPages, type WalkResult } from "@/lib/paginate";
import { strapi, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery } from "@/lib/strapi/query";
import type { Kpi } from "@/lib/types";

/** Every published KPI with its department, by name; hard cap 5 x 100. */
export function listKpis(): Promise<WalkResult<Kpi>> {
  return walkAllPages<Kpi>(
    (page) =>
      strapi<StrapiListResponse<Kpi>>(
        withQuery(
          "/api/kpis",
          strapiQuery()
            .fields(["name", "unit", "description", "period", "aggregation", "values"])
            .populateFields("department", ["name", "slug"])
            .sort(["name:asc", "id:asc"])
            .page(page, 100),
        ),
      ),
    { maxPages: 5, label: "kpis" },
  );
}
