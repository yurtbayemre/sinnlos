/**
 * Duty plans (v0.18, "Zuständigkeiten"). Every staff role reads the
 * published plans (published-only; guests hold no grant). Uncached
 * (D-DC01): who is on duty changes by the minute.
 */
import { walkAllPages, type WalkResult } from "@/lib/paginate";
import { strapi, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery } from "@/lib/strapi/query";
import type { DutyPlan } from "@/lib/types";

/** Every published plan with its department, by name; hard cap 5 x 100. */
export function listDutyPlans(): Promise<WalkResult<DutyPlan>> {
  return walkAllPages<DutyPlan>(
    (page) =>
      strapi<StrapiListResponse<DutyPlan>>(
        withQuery(
          "/api/duty-plans",
          strapiQuery()
            .fields(["name", "note", "shifts"])
            .populateFields("department", ["name", "slug"])
            .sort(["name:asc", "id:asc"])
            .page(page, 100),
        ),
      ),
    { maxPages: 5, label: "duty plans" },
  );
}
