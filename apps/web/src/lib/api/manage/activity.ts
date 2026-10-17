import type { ActivityListQuery, ActivityListResponse } from "@sinnlos/domain";
import { strapi } from "@/lib/strapi/client";
import { strapiQuery, withQuery } from "@/lib/strapi/query";

/** One bounded page; only the custom action's fixed filters can leave the web. */
export function fetchActivity(query: ActivityListQuery = {}): Promise<ActivityListResponse> {
  const qs = strapiQuery();
  for (const key of [
    "page",
    "targetUid",
    "actorKind",
    "actorId",
    "actorClass",
    "from",
    "to",
  ] as const) {
    if (query[key] !== undefined) qs.value(key, query[key]!);
  }
  return strapi<ActivityListResponse>(withQuery("/api/audit-events", qs));
}
