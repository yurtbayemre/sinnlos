import { unstable_rethrow } from "next/navigation";
import type {
  AnnouncementEditable,
  CourseEditable,
  LessonEditable,
  DocumentEditable,
  DutyPlanEditable,
  EventEditable,
  PollEditable,
  QuickLinkEditable,
} from "@sinnlos/domain";
import { fetchEditable } from "@/lib/api/manage/authoring";
import { rsvpSummaries } from "@/lib/api/events";
import { isDocumentId } from "@/lib/entry-id";
import { rsvpSummaryMap } from "@/lib/event-rsvp";
import { AREA_TYPE, type TypedArea } from "@/lib/manage/areas";
import { tryFetch } from "@/lib/safe-fetch";
import { StrapiError } from "@/lib/strapi-error";

/**
 * The edit page of one /manage item (WD03; deep-dive decision 06 §B3
 * `editable`, §L4). The form and the preview are built from `editable`
 * only: the draft in the write shape, class-aware (a department author gets
 * their class's fields), with `version`, the revision the form sends back
 * as If-Match. Never from a generic `?status=draft` read: department authors
 * have none (§C).
 *
 * A malformed documentId sends no request. A 404 (missing, or an item the
 * caller has no class on: the cms answers like a hidden findOne, S2.6) and
 * a 403 (no grant) are both `notFound`: the page shows the not-found page
 * and says nothing about whether the item exists. Known limitation: the
 * not-found page is streamed after the layout, so the web's status is 200,
 * not 404 (the cms itself answers 404). The same holds for every authoring
 * page of batch 16 (/manage/documents/[documentId], /manage/wiki/[space]
 * and its edit page, the wiki editor and history; lib/loaders/manage/
 * wiki.ts): the batch-16 spike (plan S14) put the existence check into a
 * blocking generateMetadata with a request-memoized loader shared with the
 * page, on a production build, and the missing item still answered 200,
 * for browsers (streamed metadata) and for HTML-limited bots (blocking
 * metadata) alike, behind (app)/loading.tsx; so question 18's default
 * stands (no app-wide change). Anything else that fails is `failed` (the
 * banner, no form); the sign-in redirect of an expired session is never
 * swallowed.
 */

export type EditableOf<A extends TypedArea> = A extends "courses"
  ? CourseEditable
  : A extends "lessons"
    ? LessonEditable
    : A extends "announcements"
      ? AnnouncementEditable
      : A extends "events"
        ? EventEditable
        : A extends "polls"
          ? PollEditable
          : A extends "documents"
            ? DocumentEditable
            : A extends "dutyPlans"
              ? DutyPlanEditable
              : QuickLinkEditable;

export type EditorLoad<T> =
  { state: "ok"; editable: T } | { state: "notFound" } | { state: "failed" };

/** A 404 or a 403 of an authoring read: `notFound` (see the header). */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof StrapiError && (error.status === 404 || error.status === 403);
}

/**
 * One `editable` read as an EditorLoad (see the header), logged under
 * `label`; the wiki's forms read theirs through it too
 * (lib/loaders/manage/wiki.ts).
 */
export async function editableLoad<T extends { documentId: string; version: string }>(
  label: string,
  documentId: string,
  read: () => Promise<{ data?: T } | undefined>,
): Promise<EditorLoad<T>> {
  if (!isDocumentId(documentId)) return { state: "notFound" };
  try {
    const editable = (await read())?.data;
    if (!editable || typeof editable.version !== "string" || editable.documentId !== documentId) {
      console.error(`[${label}] editable answered an unexpected shape`);
      return { state: "failed" };
    }
    return { state: "ok", editable };
  } catch (error) {
    unstable_rethrow(error);
    if (isNotFoundError(error)) return { state: "notFound" };
    console.error(`[${label}] editable failed`, error);
    return { state: "failed" };
  }
}

export function loadEditable<A extends TypedArea>(
  area: A,
  documentId: string,
): Promise<EditorLoad<EditableOf<A>>> {
  return editableLoad(`manage-${area}`, documentId, () =>
    fetchEditable<EditableOf<A>>(AREA_TYPE[area], documentId),
  );
}

/**
 * How many people said yes to a published event, for the capacity warning
 * (§L4: lowering the capacity below it removes nobody). null when it is not
 * known: a draft-only event has no summary, and a failed read warns nobody.
 */
export async function loadEventYesCount(documentId: string): Promise<number | null> {
  const result = await tryFetch(() => rsvpSummaries([documentId]), "manage-events");
  if (result.failed || !result.data) return null;
  return rsvpSummaryMap(result.data.data).get(documentId)?.yesCount ?? null;
}
