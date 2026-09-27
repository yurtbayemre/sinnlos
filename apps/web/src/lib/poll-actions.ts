"use server";

import { refresh } from "next/cache";
import { appTimeZone } from "@/lib/app-time-zone";
import { pollClosesAtForDay } from "@/lib/poll-close";
import { normalizeGuestAccess } from "@/lib/poll-guest-access";
import { canCreatePolls } from "@/lib/roles";
import { strapi } from "@/lib/strapi";
import { getViewer } from "@/lib/viewer";

export type CreatePollErrorCode = "missingQuestion" | "tooFewOptions" | "forbidden" | "failed";

export type CreatePollInput = {
  question: string;
  /** Plain option texts, one per answer — the JSON array shape the CMS
   * stores is assembled here, the form never deals with it. */
  options: string[];
  /** yyyy-mm-dd from <input type="date">, empty = no closing date. */
  closesAt: string;
  anonymous: boolean;
  /** Numeric ids of the departments to restrict the poll to; empty = everyone. */
  departmentIds: number[];
  /** Guests see the poll (owner decision 2026-09-27); missing = hidden. */
  visibleToGuests?: boolean;
  /** Guests may vote; only together with visibleToGuests. */
  guestsCanVote?: boolean;
};

export type CreatePollResult = { ok: true } | { ok: false; code: CreatePollErrorCode };

export async function createPoll(input: CreatePollInput): Promise<CreatePollResult> {
  // Poll creation is CMS-gated by global::is-admin-or-editor — mirror that
  // here so non-privileged users get a clean error instead of a 403. The
  // role is read fresh from the CMS (no render memo in a Server Action).
  if (!canCreatePolls((await getViewer()).role)) return { ok: false, code: "forbidden" };

  const question = input.question.trim();
  if (!question) return { ok: false, code: "missingQuestion" };

  // Trim, drop empties and dedupe — votes reference options by INDEX, so
  // identical entries would be indistinguishable in the results.
  const options = [...new Set(input.options.map((o) => o.trim()).filter(Boolean))];
  if (options.length < 2) return { ok: false, code: "tooFewOptions" };

  // "Closes on D" = D 23:59:59 in APP_TIME_ZONE (datetime contract), not in
  // the zone this process happens to run in.
  let closesAt: string | null = null;
  if (input.closesAt) {
    closesAt = pollClosesAtForDay(input.closesAt, appTimeZone());
    if (!closesAt) return { ok: false, code: "failed" };
  }

  // Department targeting (decision 02): the flag is set explicitly, so the
  // poll stays restricted even if its departments are deleted later (the
  // CMS then shows it to admins and editors only). Department ids are the
  // numeric ids of the single department rows (decision 05).
  const departmentIds = [
    ...new Set(input.departmentIds.filter((id) => Number.isInteger(id) && id > 0)),
  ];

  // Guest access (owner decision 2026-09-27): always sent, as strict
  // booleans, hidden unless the author ticked it; guest voting only with
  // visibility. The CMS decides per guest from these two fields.
  const { visibleToGuests, guestsCanVote } = normalizeGuestAccess(input);

  try {
    // Polls use draftAndPublish — without status=published the REST create
    // lands as an invisible draft.
    await strapi<unknown>(`/api/polls?status=published`, {
      method: "POST",
      body: JSON.stringify({
        data: {
          question,
          options,
          closesAt,
          anonymous: input.anonymous,
          audience: departmentIds.length > 0 ? "departments" : "all",
          departments: departmentIds,
          visibleToGuests,
          guestsCanVote,
        },
      }),
    });
  } catch {
    return { ok: false, code: "failed" };
  }

  // No refresh(): the form navigates to /polls right after this action, and
  // that page reads the list uncached (D-DC01). Refreshing the current route
  // (/polls/new) first would only re-render the form (FX20).
  return { ok: true };
}

export async function votePoll(pollId: number, optionIndex: number) {
  const result = await strapi<any>(`/api/polls/${pollId}/vote`, {
    method: "POST",
    body: JSON.stringify({ optionIndex }),
  });
  // Poll results are read uncached (D-DC01) — refresh so a revisit and the
  // other polls on the page show current counts without a manual reload.
  refresh();
  return result;
}
