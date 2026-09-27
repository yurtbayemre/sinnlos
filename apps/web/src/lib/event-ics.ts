import type { Event } from "@/lib/types";

/**
 * The ICS download link of an event (route app/events/[id]/ics). It names
 * the documentId: publishing re-creates the published row with a new
 * numeric id, so a row-id link from an older page would answer 404 after
 * the next publish, and the cms builds the calendar UID from the documentId
 * anyway. The numeric id is only a fallback for an entry without a
 * documentId (Strapi 5 always sends one); the route accepts both.
 */
export function icsHref(event: Pick<Event, "id" | "documentId">): string {
  const key =
    typeof event.documentId === "string" && event.documentId !== ""
      ? event.documentId
      : String(event.id);
  return `/events/${encodeURIComponent(key)}/ics`;
}
