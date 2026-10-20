/** Shared authoring areas; lessons are nested under courses and have no landing tile. */
import type { Route } from "next";
import { type AuthoringType, type TrainingAuthoringType } from "@sinnlos/domain";
import type { AuthoringArea } from "@/lib/roles";

/** The /manage areas, in landing and nav order. */
export const MANAGE_AREAS = [
  "announcements",
  "events",
  "polls",
  "quickLinks",
  "documents",
  "wiki",
  "courses",
  "dutyPlans",
] as const;

export type ManageArea = (typeof MANAGE_AREAS)[number] | "lessons";

/** The areas whose items are one K7 authored type (every area but the wiki). */
export type TypedArea = Exclude<ManageArea, "wiki">;

/** The capability area of lib/roles.ts each /manage area reads. */
export const AREA_CAPABILITY: Readonly<Record<ManageArea, AuthoringArea>> = {
  announcements: "announcements",
  events: "events",
  polls: "polls",
  quickLinks: "quickLinks",
  documents: "documents",
  wiki: "wikiSpaces",
  courses: "courses",
  lessons: "lessons",
  dutyPlans: "dutyPlans",
};

/** The K7 authored type behind each typed area. */
export const AREA_TYPE: Readonly<Record<TypedArea, AuthoringType | TrainingAuthoringType>> = {
  announcements: "announcement",
  events: "event",
  polls: "poll",
  quickLinks: "quickLink",
  documents: "document",
  courses: "course",
  lessons: "lesson",
  dutyPlans: "dutyPlan",
};

/** The list page of each area (the wiki: its spaces). */
export const AREA_PATH: Readonly<Record<ManageArea, Route>> = {
  announcements: "/manage/announcements",
  events: "/manage/events",
  polls: "/manage/polls",
  quickLinks: "/manage/quick-links",
  documents: "/manage/documents",
  wiki: "/manage/wiki",
  courses: "/manage/training",
  lessons: "/manage/training",
  dutyPlans: "/manage/duty-plans",
};

/** The create page of each area (the wiki: a new space). */
export const AREA_NEW_PATH: Readonly<Record<ManageArea, Route>> = {
  announcements: "/manage/announcements/new",
  events: "/manage/events/new",
  polls: "/manage/polls/new",
  quickLinks: "/manage/quick-links/new",
  documents: "/manage/documents/new",
  wiki: "/manage/wiki/new",
  courses: "/manage/training/new",
  lessons: "/manage/training",
  dutyPlans: "/manage/duty-plans/new",
};

/** The page of one item: its editor (the wiki: the space's page tree). */
export function areaItemPath(area: ManageArea, documentId: string): Route {
  return `${AREA_PATH[area]}/${encodeURIComponent(documentId)}` as Route;
}

export function isManageArea(value: unknown): value is ManageArea {
  return value === "lessons" || (MANAGE_AREAS as readonly unknown[]).includes(value);
}

/**
 * Areas with drafts, publish, unpublish and discard (`explicit` status):
 * every typed area but polls, which publish at create (`alwaysPublished`)
 * and close through `closesAt` (§A).
 */
export function hasDrafts(area: TypedArea): boolean {
  return area !== "polls";
}

/**
 * The fields of the Schedule… dialog per area (§D): `publishAt` on
 * announcements, events, quick links, documents and wiki pages;
 * `unpublishAt` on quick links and documents (announcements end with
 * `expiresAt`, events end).
 */
export const SCHEDULE_FIELDS: Readonly<
  Record<ManageArea, readonly ("publishAt" | "unpublishAt")[]>
> = {
  announcements: ["publishAt"],
  events: ["publishAt"],
  polls: [],
  quickLinks: ["publishAt", "unpublishAt"],
  documents: ["publishAt", "unpublishAt"],
  wiki: ["publishAt"],
  courses: ["publishAt"],
  lessons: ["publishAt"],
  dutyPlans: [],
};

/**
 * Areas whose publish notifies readers (the announcement and event
 * fan-outs): their Publish asks first, "Publishing notifies the audience
 * now" (§L5).
 */
export function notifiesOnPublish(area: ManageArea): boolean {
  return area === "announcements" || area === "events";
}

/**
 * Areas that carry an owner department and the department-author class
 * (§N2): announcements, events, documents and duty plans.
 */
export function hasOwnerDepartment(area: TypedArea): boolean {
  return (
    area === "announcements" || area === "events" || area === "documents" || area === "dutyPlans"
  );
}
