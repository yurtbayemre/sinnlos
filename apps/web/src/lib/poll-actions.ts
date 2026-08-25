"use server";

import { refresh, updateTag } from "next/cache";
import { auth } from "@/auth";
import { strapi } from "@/lib/strapi";

export type CreatePollErrorCode = "missingQuestion" | "tooFewOptions" | "forbidden" | "failed";

export type CreatePollInput = {
  question: string;
  /** Plain option texts, one per answer — the JSON array shape the CMS
   * stores is assembled here, the form never deals with it. */
  options: string[];
  /** yyyy-mm-dd from <input type="date">, empty = no closing date. */
  closesAt: string;
  anonymous: boolean;
  departmentIds: number[];
};

export type CreatePollResult = { ok: true } | { ok: false; code: CreatePollErrorCode };

/** Poll creation is CMS-gated by global::is-admin-or-editor — mirror that
 * here so non-privileged users get a clean error instead of a 403. */
const POLL_CREATOR_ROLES = new Set(["admin_role", "editor"]);

export async function createPoll(input: CreatePollInput): Promise<CreatePollResult> {
  const session = await auth();
  const role = session?.user?.role;
  if (!role || !POLL_CREATOR_ROLES.has(role)) return { ok: false, code: "forbidden" };

  const question = input.question.trim();
  if (!question) return { ok: false, code: "missingQuestion" };

  // Trim, drop empties and dedupe — votes reference options by INDEX, so
  // identical entries would be indistinguishable in the results.
  const options = [...new Set(input.options.map((o) => o.trim()).filter(Boolean))];
  if (options.length < 2) return { ok: false, code: "tooFewOptions" };

  const closesAt = input.closesAt ? new Date(`${input.closesAt}T23:59:59`).toISOString() : null;

  try {
    // Polls use draftAndPublish — without status=published the REST create
    // lands as an invisible draft.
    await strapi<any>(`/api/polls?status=published`, {
      method: "POST",
      body: JSON.stringify({
        data: {
          question,
          options,
          closesAt,
          anonymous: input.anonymous,
          departments: input.departmentIds,
        },
      }),
      noCache: true,
    });
  } catch {
    return { ok: false, code: "failed" };
  }

  // The polls list is cached under this tag (revalidate 30) — updateTag
  // gives read-your-own-writes, refresh() re-renders the current route.
  updateTag("polls");
  refresh();
  return { ok: true };
}

export async function votePoll(pollId: number, optionIndex: number) {
  const result = await strapi<any>(`/api/polls/${pollId}/vote`, {
    method: "POST",
    body: JSON.stringify({ optionIndex }),
    noCache: true,
  });
  // Poll results are fetched with noCache — refresh so a revisit and the
  // other polls on the page show current counts without a manual reload.
  refresh();
  return result;
}
