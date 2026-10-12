"use server";

import { refresh } from "next/cache";
import { runCmsAction, type ActionResult } from "@/lib/action-result";
import { strapi } from "@/lib/strapi";
import type { KudosValue } from "@/lib/types";

/**
 * Sends kudos. Answers an ActionResult (AC01); the cms validates recipient,
 * message and value (a 400 is "invalid", e.g. kudos to oneself).
 */
export async function sendKudos(
  toUserId: number,
  message: string,
  value: KudosValue,
): Promise<ActionResult> {
  return runCmsAction(
    () =>
      strapi("/api/kudos-entries", {
        method: "POST",
        body: JSON.stringify({
          data: { to: toUserId, message, value },
        }),
      }),
    {
      label: "[kudos] send",
      // The kudos feed is read uncached (D-DC01) — re-render it in the
      // action response so the new entry appears without a manual reload.
      after: () => refresh(),
    },
  );
}
