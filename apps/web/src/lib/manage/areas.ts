/**
 * The /manage areas of v2 authoring phase 1 (deep-dive decision 06 §L1;
 * batch 15 plan, lane 15C): announcements, events, polls and quick links.
 * Each area is one authored type of the K7 contract (@sinnlos/domain
 * authoring/*) and one capability area of lib/roles.ts (SH02). Pure data,
 * usable from server and client code.
 *
 * Documents (16C), the wiki (16C) and training (17C) join later; their
 * capability areas exist already, so nothing here may assume that every
 * AuthoringArea of lib/roles.ts is a /manage area.
 */
import type { Route } from "next";
import { AUTHORING_STATUS_MODES, type AuthoringType } from "@sinnlos/domain";
import type { AuthoringArea } from "@/lib/roles";

/** The /manage areas of phase 1, in landing and nav order. */
export const MANAGE_AREAS = [
  "announcements",
  "events",
  "polls",
  "quickLinks",
] as const satisfies readonly AuthoringArea[];

export type ManageArea = (typeof MANAGE_AREAS)[number];

/** The K7 authored type behind each area. */
export const AREA_TYPE: Readonly<Record<ManageArea, AuthoringType>> = {
  announcements: "announcement",
  events: "event",
  polls: "poll",
  quickLinks: "quickLink",
};

/** The list page of each area. */
export const AREA_PATH: Readonly<Record<ManageArea, Route>> = {
  announcements: "/manage/announcements",
  events: "/manage/events",
  polls: "/manage/polls",
  quickLinks: "/manage/quick-links",
};

/** The create page of each area. */
export const AREA_NEW_PATH: Readonly<Record<ManageArea, Route>> = {
  announcements: "/manage/announcements/new",
  events: "/manage/events/new",
  polls: "/manage/polls/new",
  quickLinks: "/manage/quick-links/new",
};

/** The edit page of one item. */
export function areaItemPath(area: ManageArea, documentId: string): Route {
  return `${AREA_PATH[area]}/${encodeURIComponent(documentId)}` as Route;
}

export function isManageArea(value: unknown): value is ManageArea {
  return (MANAGE_AREAS as readonly unknown[]).includes(value);
}

/**
 * Areas with drafts, publish, unpublish and discard (`explicit` status):
 * every phase-1 area but polls, which publish at create (`alwaysPublished`)
 * and close through `closesAt` (§A).
 */
export function hasDrafts(area: ManageArea): boolean {
  return AUTHORING_STATUS_MODES[AREA_TYPE[area]] === "explicit";
}

/**
 * Areas whose items can be scheduled (§D): `publishAt` on announcements,
 * events and quick links; `unpublishAt` on quick links only (announcements
 * end with `expiresAt`, events end).
 */
export const SCHEDULE_FIELDS: Readonly<
  Record<ManageArea, readonly ("publishAt" | "unpublishAt")[]>
> = {
  announcements: ["publishAt"],
  events: ["publishAt"],
  polls: [],
  quickLinks: ["publishAt", "unpublishAt"],
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
 * (§N2): announcements and events in phase 1 (documents in 16C).
 */
export function hasOwnerDepartment(area: ManageArea): boolean {
  return area === "announcements" || area === "events";
}
