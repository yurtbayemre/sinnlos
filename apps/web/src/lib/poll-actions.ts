"use server";

import { refresh } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { appTimeZone } from "@/lib/app-time-zone";
import { parseEntryRef } from "@/lib/entry-id";
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
  } catch (e) {
    // strapi() answers an expired session with redirect() (NEXT_REDIRECT);
    // it must reach Next.js so the author lands on /sign-in?expired=1
    // instead of a "failed" message (FX47).
    unstable_rethrow(e);
    return { ok: false, code: "failed" };
  }

  // No refresh(): the form navigates to /polls right after this action, and
  // that page reads the list uncached (D-DC01). Refreshing the current route
  // (/polls/new) first would only re-render the form (FX20).
  return { ok: true };
}

/**
 * Longest option text a vote carries. The poll form caps an answer at 120
 * characters; the admin panel has no cap, so this only bounds what a crafted
 * call can make the action forward.
 */
const MAX_OPTION_TEXT = 10_000;

/**
 * Casts the caller's vote. `pollRef` is the poll's documentId (DA01, the
 * address that survives a republish) or, from a card rendered before DA01,
 * the published row's numeric id; the cms accepts both and stores the vote
 * on the published row. A Server Action's arguments come from the client,
 * so anything else is refused before a request.
 *
 * `option` is the answer text the card showed at `optionIndex`. The cms
 * stores the index, so after an edit that reordered or replaced the options
 * it refuses a vote whose text no longer sits there (400 "Poll options
 * changed") instead of recording a different answer; the card then shows
 * voteFailed and reloads. Without it (an older card) the cms does not
 * compare.
 */
export async function votePoll(pollRef: string | number, optionIndex: number, option?: string) {
  const ref = parseEntryRef(pollRef);
  if (!ref) throw new Error("invalid poll reference");
  if (option !== undefined && (typeof option !== "string" || option.length > MAX_OPTION_TEXT)) {
    throw new Error("invalid poll option");
  }
  const address = "documentId" in ref ? ref.documentId : String(ref.id);
  const result = await strapi<unknown>(`/api/polls/${address}/vote`, {
    method: "POST",
    body: JSON.stringify(option === undefined ? { optionIndex } : { optionIndex, option }),
  });
  // Poll results are read uncached (D-DC01) — refresh so a revisit and the
  // other polls on the page show current counts without a manual reload.
  refresh();
  return result;
}
