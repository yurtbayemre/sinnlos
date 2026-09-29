"use server";

/**
 * Event RSVP server action. One endpoint for create AND change: the CMS
 * controller upserts per (user, targetDocumentId), pins the user
 * server-side and enforces published + rsvpEnabled + capacity.
 *
 * Answers an ActionResult (AC01): "full" for the capacity refusal, the
 * common codes otherwise; the RSVP panel translates them (i18n rule — no
 * user-facing strings here).
 */
import { refresh } from "next/cache";
import { actionFailure, runCmsAction, type ActionResult } from "@/lib/action-result";
import { strapi } from "@/lib/strapi";
import type { RsvpStatus } from "@/lib/types";

export type RsvpErrorCode = "full";

const STATUSES: RsvpStatus[] = ["yes", "no", "maybe"];

/**
 * The cms's capacity refusal (event-rsvp controller: ctx.badRequest). A
 * bare badRequest carries no machine code — every 400 there is a
 * BadRequestError — so the parsed envelope message is compared exactly
 * (not a substring of the raw error text); event-actions.test.ts pins the
 * text against the cms controller.
 */
const CAPACITY_REFUSAL = "Event is at capacity";

export async function rsvpToEvent(
  targetDocumentId: string,
  status: RsvpStatus,
): Promise<ActionResult<RsvpErrorCode>> {
  if (typeof targetDocumentId !== "string" || !targetDocumentId || !STATUSES.includes(status)) {
    return actionFailure("invalid");
  }
  return runCmsAction<RsvpErrorCode>(
    () =>
      strapi("/api/event-rsvps", {
        method: "POST",
        body: JSON.stringify({ data: { targetDocumentId, status } }),
      }),
    {
      label: "[events] rsvp",
      mapError: (cms) =>
        cms.status === 400 && cms.message === CAPACITY_REFUSAL ? "full" : undefined,
      // Server-rendered attendee lists/counts update in the action response.
      after: () => refresh(),
    },
  );
}
