"use server";

/**
 * The readers' poll action: votePoll. Polls are created and edited in
 * /manage since batch 15 (lib/manage/poll-actions.ts); the old createPoll
 * and its /polls/new form are retired.
 */
import { refresh } from "next/cache";
import { actionFailure, runCmsAction, type ActionResult } from "@/lib/action-result";
import { parseEntryRef } from "@/lib/entry-id";
import { strapi } from "@/lib/strapi";

/**
 * Longest option text a vote carries. The /manage poll form caps an answer at
 * 200 characters, the admin panel not at all, so this only bounds what a
 * crafted call can make the action forward.
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
