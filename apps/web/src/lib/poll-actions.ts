"use server";

import { refresh } from "next/cache";
import {
  actionFailure,
  runCmsAction,
  type ActionResult,
  type CommonCode,
} from "@/lib/action-result";
import { appTimeZone } from "@/lib/app-time-zone";
import { parseEntryRef } from "@/lib/entry-id";
import { pollClosesAtForDay } from "@/lib/poll-close";
import { normalizeGuestAccess } from "@/lib/poll-guest-access";
import { canCreatePolls } from "@/lib/roles";
import { strapi } from "@/lib/strapi";
import { getViewer } from "@/lib/viewer";

/** createPoll's own codes: the local checks before any request. */
type CreatePollCode = "missingQuestion" | "tooFewOptions";

/** Every code createPoll answers; the form shows polls.formError_<code>. */
export type CreatePollErrorCode = CreatePollCode | CommonCode;

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

/** An ActionResult (AC01): the local checks, then the common CMS mapping. */
export type CreatePollResult = ActionResult<CreatePollCode>;

export async function createPoll(input: CreatePollInput): Promise<CreatePollResult> {
  // Poll creation is CMS-gated by global::is-admin-or-editor — mirror that
  // here so non-privileged users get a clean error instead of a 403. The
  // role is read fresh from the CMS (no render memo in a Server Action).
  if (!canCreatePolls((await getViewer()).role)) return actionFailure("forbidden");

  const question = input.question.trim();
  if (!question) return actionFailure("missingQuestion");

  // Trim, drop empties and dedupe — votes reference options by INDEX, so
  // identical entries would be indistinguishable in the results.
  const options = [...new Set(input.options.map((o) => o.trim()).filter(Boolean))];
  if (options.length < 2) return actionFailure("tooFewOptions");

  // "Closes on D" = D 23:59:59 in APP_TIME_ZONE (datetime contract), not in
  // the zone this process happens to run in.
  let closesAt: string | null = null;
  if (input.closesAt) {
    closesAt = pollClosesAtForDay(input.closesAt, appTimeZone());
    if (!closesAt) return actionFailure("invalid");
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

  // runCmsAction lets strapi()'s redirect on an expired session
  // (NEXT_REDIRECT) reach Next.js, so the author lands on
  // /sign-in?expired=1 instead of a failure message (FX47).
  // No refresh(): the form navigates to /polls right after this action, and
  // that page reads the list uncached (D-DC01). Refreshing the current route
  // (/polls/new) first would only re-render the form (FX20).
  return runCmsAction<CreatePollCode>(
    () =>
      // Polls use draftAndPublish — without status=published the REST
      // create lands as an invisible draft.
      strapi<unknown>(`/api/polls?status=published`, {
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
      }),
    { label: "[polls] create" },
  );
}

/**
 * Longest option text a vote carries. The poll form caps an answer at 120
 * characters; the admin panel has no cap, so this only bounds what a crafted
 * call can make the action forward.
 */
const MAX_OPTION_TEXT = 10_000;

/** votePoll's own code: the stale-card refusal (batch 9). */
export type VoteErrorCode = "pollOptionsChanged";

/**
 * The cms's stale-card refusal (poll-vote controller: ctx.badRequest). A
 * bare badRequest carries no machine code — every 400 there is a
 * BadRequestError — so the parsed envelope message is compared exactly;
 * poll-actions.test.ts pins the text against the cms controller.
 */
const OPTIONS_CHANGED = "Poll options changed";

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
 * changed") instead of recording a different answer; that refusal answers
 * its own code, pollOptionsChanged, and the card says so and reloads.
 * Without it (an older card) the cms does not compare.
 *
 * Answers an ActionResult (AC01): a bad reference or option text is
 * "invalid" before any request; the cms's other refusals (already voted,
 * closed, outside the audience) take the common mapping.
 */
export async function votePoll(
  pollRef: string | number,
  optionIndex: number,
  option?: string,
): Promise<ActionResult<VoteErrorCode>> {
  const ref = parseEntryRef(pollRef);
  if (!ref) return actionFailure("invalid");
  if (option !== undefined && (typeof option !== "string" || option.length > MAX_OPTION_TEXT)) {
    return actionFailure("invalid");
  }
  const address = "documentId" in ref ? ref.documentId : String(ref.id);
  return runCmsAction<VoteErrorCode>(
    () =>
      strapi<unknown>(`/api/polls/${address}/vote`, {
        method: "POST",
        body: JSON.stringify(option === undefined ? { optionIndex } : { optionIndex, option }),
      }),
    {
      label: "[polls] vote",
      mapError: (cms) =>
        cms.status === 400 && cms.message === OPTIONS_CHANGED ? "pollOptionsChanged" : undefined,
      // Poll results are read uncached (D-DC01) — refresh so a revisit and
      // the other polls on the page show current counts without a manual
      // reload.
      after: () => refresh(),
    },
  );
}
