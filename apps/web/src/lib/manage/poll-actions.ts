"use server";

import { actionFailure } from "@/lib/action-result";
import {
  authorContext,
  authoringWrite,
  transitionItem,
  validReference,
  type AuthoringActionResult,
} from "./authoring-action";
import { buildPollPayload } from "./payload";
import { saveItem, type SaveInput } from "./save";
import { coercePollValues } from "./values";

/**
 * The poll actions of /manage (deep-dive decision 06 §A, §L3, §L4; batch 15
 * plan, lane 15C items 3 and 4). A poll has no drafts: its create publishes
 * (the cms's `alwaysPublished`, so no `status` is sent), an update saves
 * the published poll, and a poll ends through `closesAt` ("Close now").
 * After the first vote its options and anonymity are frozen
 * (frozenAfterVotes): the form locks them, the payload never carries them,
 * and the cms refuses them anyway. Moderators only. Not to be confused with
 * lib/poll-actions.ts, the readers' vote (and the old create, retired with
 * /polls/new).
 */

/** Create or update a poll; `hasVotes` (from `editable`) leaves options and anonymity out. */
export async function savePoll(
  input: SaveInput & { hasVotes?: unknown },
): Promise<AuthoringActionResult> {
  const hasVotes = typeof input === "object" && input !== null && input.hasVotes === true;
  return saveItem("polls", input, {
    coerce: coercePollValues,
    build: (values, initial, ctx) => buildPollPayload(values, initial, { ...ctx, hasVotes }),
  });
}

/** "Close now": closesAt = this instant, so voting ends at once (the poll close rule). */
export async function closePoll(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  const gate = await authorContext("polls", ["edit"]);
  if (!gate.ok) return gate.failure;
  if (!validReference(documentId, version)) return actionFailure("invalid");
  return authoringWrite(
    "polls",
    "update",
    { documentId, version: version as string, data: { closesAt: new Date().toISOString() } },
    { refreshPage: true },
  );
}

export async function deletePoll(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("polls", "delete", documentId, version);
}
