import { unstable_rethrow } from "next/navigation";
import type {
  AnnouncementEditable,
  DocumentEditable,
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
 * not 404 (the cms itself answers 404). Anything else that fails is
 * `failed` (the banner, no form); the sign-in redirect of an expired
 * session is never swallowed.
 */

export type EditableOf<A extends TypedArea> = A extends "announcements"
  ? AnnouncementEditable
  : A extends "events"
    ? EventEditable
    : A extends "polls"
      ? PollEditable
      : A extends "documents"
        ? DocumentEditable
        : QuickLinkEditable;

export type EditorLoad<T> =
  { state: "ok"; editable: T } | { state: "notFound" } | { state: "failed" };

export async function loadEditable<A extends TypedArea>(
  area: A,
  documentId: string,
): Promise<EditorLoad<EditableOf<A>>> {
  if (!isDocumentId(documentId)) return { state: "notFound" };
  try {
    const answer = await fetchEditable<EditableOf<A>>(AREA_TYPE[area], documentId);
    const editable = answer?.data;
    if (!editable || typeof editable.version !== "string" || editable.documentId !== documentId) {
      console.error(`[manage-${area}] editable answered an unexpected shape`);
      return { state: "failed" };
    }
    return { state: "ok", editable };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof StrapiError && (error.status === 404 || error.status === 403)) {
      return { state: "notFound" };
    }
    console.error(`[manage-${area}] editable failed`, error);
    return { state: "failed" };
  }
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
