import {
  AUTHORING_ROLE_CLASSES,
  WIKI_EDITOR_CLASSES,
  type ActivityListQuery,
  type ActivityTargetUid,
} from "@sinnlos/domain";
import type { Route } from "next";
import { fetchActivity } from "@/lib/api/manage/activity";
import { wallTimeInstant } from "@/lib/manage/datetime";
import { instantEpochMs } from "@/lib/plain-date";
import { tryFetch } from "@/lib/safe-fetch";
import { NO_PAGES, pageParam, type ListSearchParams } from "./list";

export const ACTIVITY_TARGETS = {
  "api::announcement.announcement": "announcement",
  "api::event.event": "event",
  "api::quick-link.quick-link": "quickLink",
  "api::document.document": "document",
  "api::poll.poll": "poll",
  "api::wiki-space.wiki-space": "wikiSpace",
  "api::wiki-page.wiki-page": "wikiPage",
  "api::course.course": "course",
  "api::lesson.lesson": "lesson",
  "api::duty-plan.duty-plan": "dutyPlan",
  "api::department.department": "department",
  "api::team.team": "team",
  "api::classified.classified": "classified",
  "plugin::upload.file": "file",
} as const satisfies Record<ActivityTargetUid, string>;
export const ACTIVITY_KINDS = ["user", "admin", "system"] as const;
export const ACTIVITY_CLASSES = [...new Set([...AUTHORING_ROLE_CLASSES, ...WIKI_EDITOR_CLASSES])];
const FILTER_KEYS = [
  "targetUid",
  "actorKind",
  "actorId",
  "actorClass",
  "fromDate",
  "fromTime",
  "toDate",
  "toTime",
] as const;
export type ActivityFilters = Record<(typeof FILTER_KEYS)[number], string> & { page: number };

export function parseActivityFilters(params: ListSearchParams): ActivityFilters {
  return {
    ...Object.fromEntries(
      FILTER_KEYS.map((key) => [key, typeof params[key] === "string" ? params[key] : ""]),
    ),
    page: pageParam(params),
  } as ActivityFilters;
}

/** Date/time pairs use the deployment zone, including refusal of skipped/repeated wall times. */
export function activityQuery(
  filters: ActivityFilters,
  timeZone: string,
): ActivityListQuery | null {
  const { targetUid, actorKind, actorClass, actorId } = filters;
  if (
    (targetUid && !Object.hasOwn(ACTIVITY_TARGETS, targetUid)) ||
    (actorKind && !(ACTIVITY_KINDS as readonly string[]).includes(actorKind)) ||
    (actorClass && !(ACTIVITY_CLASSES as readonly string[]).includes(actorClass))
  )
    return null;
  if (
    actorId &&
    (!/^[1-9]\d*$/.test(actorId) ||
      Number(actorId) > 2_147_483_647 ||
      (actorKind !== "user" && actorKind !== "admin"))
  )
    return null;
  const from = wallTimeInstant(filters.fromDate, filters.fromTime, timeZone);
  const to = wallTimeInstant(filters.toDate, filters.toTime, timeZone);
  if ("code" in from || "code" in to) return null;
  if (from.value && to.value && instantEpochMs(from.value)! > instantEpochMs(to.value)!)
    return null;
  return {
    page: filters.page,
    ...(targetUid ? { targetUid: targetUid as ActivityListQuery["targetUid"] } : {}),
    ...(actorKind ? { actorKind: actorKind as ActivityListQuery["actorKind"] } : {}),
    ...(actorClass ? { actorClass: actorClass as ActivityListQuery["actorClass"] } : {}),
    ...(actorId ? { actorId: Number(actorId) } : {}),
    ...(from.value ? { from: from.value } : {}),
    ...(to.value ? { to: to.value } : {}),
  };
}

export function activityHref(filters: ActivityFilters, page: number): Route {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) if (filters[key]) params.set(key, filters[key]);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return (query ? `/manage/activity?${query}` : "/manage/activity") as Route;
}

export async function loadActivity(filters: ActivityFilters, timeZone: string) {
  const query = activityQuery(filters, timeZone);
  const result = query ? await tryFetch(() => fetchActivity(query), "manage-activity") : null;
  const rows = result?.data?.data ?? [];
  return {
    rows,
    pagination: result?.data?.meta.pagination ?? { ...NO_PAGES, page: filters.page },
    invalid: query === null,
    failed: result?.failed ?? false,
    empty: query !== null && !result?.failed && rows.length === 0,
  };
}
