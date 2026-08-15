"use server";

/**
 * Event RSVP server action. One endpoint for create AND change: the CMS
 * controller upserts per (user, targetDocumentId), pins the user
 * server-side and enforces published + rsvpEnabled + capacity.
 *
 * Error contract: machine codes only (i18n rule — no user-facing strings
 * here); the RSVP panel translates them. Thrown action errors would be
 * masked by Next in production, hence the returned-code shape.
 */
import { refresh } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { strapi } from "@/lib/strapi";
import type { RsvpStatus } from "@/lib/types";

export type RsvpErrorCode = "full" | "failed";

const STATUSES: RsvpStatus[] = ["yes", "no", "maybe"];

export async function rsvpToEvent(
  targetDocumentId: string,
  status: RsvpStatus,
): Promise<{ error?: RsvpErrorCode }> {
  if (!targetDocumentId || !STATUSES.includes(status)) return { error: "failed" };
  try {
    await strapi("/api/event-rsvps", {
      method: "POST",
      body: JSON.stringify({ data: { targetDocumentId, status } }),
      noCache: true,
    });
  } catch (e) {
    // strapi()'s 401 → sign-in redirect (NEXT_REDIRECT) must propagate.
    unstable_rethrow(e);
    console.error("[events] rsvp failed", e);
    // strapi() embeds the CMS error body in the thrown message — detect
    // the capacity rejection so the UI can explain it distinctly.
    const full = e instanceof Error && e.message.includes("at capacity");
    return { error: full ? "full" : "failed" };
  }
  // Server-rendered attendee lists/counts update in the action response.
  refresh();
  return {};
}
