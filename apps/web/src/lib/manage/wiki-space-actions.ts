"use server";

import { unstable_rethrow } from "next/navigation";
import { actionFailure } from "@/lib/action-result";
import { fetchWikiSpaceEditable } from "@/lib/api/manage/wiki";
import { authorContext, validReference } from "./authoring-action";
import type { SaveInput } from "./save";
import { wikiSpaceWrite, type WikiSpaceActionResult } from "./wiki-action";
import { buildWikiSpacePayload } from "./wiki-payload";
import { coerceWikiSpaceValues } from "./wiki-values";

/**
 * The wiki-space actions of /manage/wiki (deep-dive decision 06 §J1, §B3,
 * §L3; batch 16 plan, lane 16C item 4; contract K18). Moderators only (the
 * `wikiSpaces` capability area, read through the wiki area). A space is
 * always published: a create publishes it, an update saves the published
 * space (no `status`), and there is no publish, unpublish or discard. Its
 * slug is derived from the name on create and fixed afterwards.
 *
 * A delete takes If-Match like every mutation; a space that still has
 * pages answers 400 `_form: spaceNotEmpty`, which the form explains.
 */

const isRecord = (value: unknown): value is SaveInput =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Create or update a space. */
export async function saveWikiSpace(rawInput: SaveInput): Promise<WikiSpaceActionResult> {
  const input: SaveInput = isRecord(rawInput) ? rawInput : { values: undefined };
  const mode = input.documentId === undefined || input.documentId === null ? "create" : "update";
  const gate = await authorContext("wiki", [mode === "create" ? "create" : "edit"]);
  if (!gate.ok) return gate.failure as WikiSpaceActionResult;
  if (mode === "update" && !validReference(input.documentId, input.version)) {
    return actionFailure("invalid");
  }

  const values = coerceWikiSpaceValues(input.values);
  const initial =
    mode === "update" && input.initial !== undefined && input.initial !== null
      ? coerceWikiSpaceValues(input.initial)
      : null;
  const retarget = input.retarget === true;
  let built = buildWikiSpacePayload(values, initial, { mode, retarget });
  if (!built.ok) return actionFailure("invalid", { fields: built.fields });
  if (mode === "update" && !retarget && built.data.visibility === "public") {
    // Never make a space whose target is gone public by accident: the cms
    // decides whether it needs re-targeting, not the form (save.ts).
    let needsRetarget: boolean;
    try {
      const answer = await fetchWikiSpaceEditable(input.documentId as string);
      needsRetarget = answer?.data?.needsRetarget === true;
    } catch (error) {
      unstable_rethrow(error);
      return actionFailure("unavailable");
    }
    if (needsRetarget) {
      built = buildWikiSpacePayload(values, initial, { mode, retarget, needsRetarget });
      if (!built.ok) return actionFailure("invalid", { fields: built.fields });
    }
  }

  return wikiSpaceWrite(
    mode,
    {
      ...(mode === "update"
        ? { documentId: input.documentId as string, version: input.version as string }
        : {}),
      data: built.data,
    },
    { refreshPage: mode === "update" },
  );
}

/** Delete an empty space (If-Match); `spaceNotEmpty` while it has pages. */
export async function deleteWikiSpace(
  documentId: unknown,
  version: unknown,
): Promise<WikiSpaceActionResult> {
  const gate = await authorContext("wiki", ["delete"]);
  if (!gate.ok) return gate.failure as WikiSpaceActionResult;
  if (!validReference(documentId, version)) return actionFailure("invalid");
  return wikiSpaceWrite(
    "delete",
    { documentId, version: version as string },
    { refreshPage: false },
  );
}
