/** The kudos wall and the celebrations (WD01). Uncached (D-DC01). */
import { strapi, type StrapiDataResponse, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery } from "@/lib/strapi/query";
import type { Celebration, Kudos } from "@/lib/types";

/**
 * pageSize=30 is a deliberate feed/render cap (issue #26) — counts must
 * come from `meta.pagination.total`, never `data.length`.
 */
export function listKudos(): Promise<StrapiListResponse<Kudos>> {
  return strapi<StrapiListResponse<Kudos>>(
    withQuery(
      "/api/kudos-entries",
      strapiQuery().populate("from").populate("to").sortBy("createdAt:desc").pageSize(30),
    ),
  );
}

/**
 * Birthdays (opt-in) and work anniversaries of the next 30 days, computed
 * by the cms (staff roles only: years + daysUntil would reconstruct a
 * hireDate for anyone else).
 */
export function listCelebrations(): Promise<StrapiDataResponse<Celebration[]>> {
  return strapi<StrapiDataResponse<Celebration[]>>(
    withQuery("/api/celebrations", strapiQuery().literal("window", 30)),
  );
}
