"use server";

import { actionFailure } from "@/lib/action-result";
import { appTimeZone } from "@/lib/app-time-zone";
import { isDocumentId } from "@/lib/entry-id";
import type { WikiPageWriteIntent } from "@/lib/api/manage/wiki";
import { isWriteStatus, validReference } from "./authoring-action";
import type { SaveInput } from "./save";
import { coerceScheduleValues } from "./values";
import {
  isRevisionId,
  wikiContext,
  wikiPageClass,
  wikiPageWrite,
  type WikiPageActionResult,
} from "./wiki-action";
import { buildWikiPagePayload, buildWikiSchedulePayload } from "./wiki-payload";
import { coerceWikiPageValues } from "./wiki-values";

/**
 * The wiki-page actions of the wiki editor (deep-dive decision 06 §J2,
 * §L3, §L4; batch 16 plan, lane 16C items 5 and 6; contract K18). Every
 * argument is untrusted; every answer is an AC01 ActionResult.
 *
 * Which route a save takes:
 *   - moderators (the `moderator` class) write through the generic routes
 *     with an explicit status: create `POST ?status=draft|published`,
 *     update `PUT /:id?status=draft|published` (If-Match), optionally with
 *     the schedule (`publishAt`);
 *   - every other class (department heads and team leads creating, the
 *     page's author, its department's head and its team's lead editing)
 *     drafts through the draft actions, which never publish: createDraft
 *     and saveDraft (If-Match); "Save and publish" takes the generic
 *     route, which the cms pins to published for them.
 * The payload carries the class's keys only (WIKI_FIELDS): an author never
 * sends department, team or publishAt.
 *
 * Transitions: publish and discard (the row classes and moderators; a
 * discard of a page without a published version deletes it, which only its
 * author and moderators may do: the cms answers 404 to everyone else),
 * unpublish and delete (moderators), restore (the row classes and
 * moderators; the draft update and the publish run in one transaction
 * under one If-Match).
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What the wiki editor sends to save a page (every field untrusted). */
export interface WikiPageSaveInput extends SaveInput {
  /** A create: the space's documentId (from the page the form was opened in). */
  space?: unknown;
}

/** Create or update a page, as a draft or published (moderators: optionally scheduled). */
export async function saveWikiPage(rawInput: WikiPageSaveInput): Promise<WikiPageActionResult> {
  const input = isRecord(rawInput) ? (rawInput as WikiPageSaveInput) : { values: undefined };
  const mode = input.documentId === undefined || input.documentId === null ? "create" : "update";
  const status = isWriteStatus(input.status) ? input.status : undefined;
  const schedules = input.schedule !== undefined && input.schedule !== null;

  const gate = await wikiContext();
  if (!gate.ok) return gate.failure;
  const { wikiPages } = gate.context.capabilities;
  const allowed =
    (mode === "create" ? wikiPages.create : wikiPages.edit !== "none") &&
    (!schedules || wikiPages.schedule);
  if (!allowed) return actionFailure("forbidden");
  if (!status) return actionFailure("invalid");
  if (mode === "update" && !validReference(input.documentId, input.version)) {
    return actionFailure("invalid");
  }
  const space = mode === "create" && isDocumentId(input.space) ? input.space : null;
  if (mode === "create" && !space) return actionFailure("invalid");

  const roleClass = wikiPageClass(gate.context.capabilities);
  const ctx = { mode, roleClass, space, timeZone: appTimeZone(), now: Date.now() } as const;
  const values = coerceWikiPageValues(input.values);
  const initial =
    mode === "update" && isRecord(input.initial) ? coerceWikiPageValues(input.initial) : null;
  const built = buildWikiPagePayload(values, initial, ctx);
  if (!built.ok) return actionFailure("invalid", { fields: built.fields });
  let data = built.data;
  if (schedules) {
    const schedule = buildWikiSchedulePayload(coerceScheduleValues(input.schedule), ctx);
    if (!schedule.ok) return actionFailure("invalid", { fields: schedule.fields });
    data = { ...data, ...schedule.data };
  }

  // The route (see the header): moderators the generic one with their
  // status; the other classes draft through the draft actions.
  let intent: WikiPageWriteIntent = mode;
  if (roleClass !== "moderator" && status === "draft") {
    intent = mode === "create" ? "createDraft" : "saveDraft";
  }
  const generic = intent === "create" || intent === "update";
  return wikiPageWrite(
    intent,
    {
      ...(mode === "update"
        ? { documentId: input.documentId as string, version: input.version as string }
        : {}),
      ...(generic ? { status } : {}),
      data,
    },
    { refreshPage: mode === "update" },
  );
}

type Transition = "publish" | "unpublish" | "discardDraft" | "delete";

async function transition(
  intent: Transition,
  documentId: unknown,
  version: unknown,
): Promise<WikiPageActionResult> {
  const gate = await wikiContext();
  if (!gate.ok) return gate.failure;
  const { wikiPages } = gate.context.capabilities;
  const allowed =
    intent === "unpublish"
      ? wikiPages.unpublish
      : intent === "delete"
        ? wikiPages.delete
        : wikiPages.edit !== "none";
  if (!allowed) return actionFailure("forbidden");
  if (!validReference(documentId, version)) return actionFailure("invalid");
  return wikiPageWrite(
    intent,
    { documentId, version: version as string },
    // A delete navigates away; so does a discard that removed the page.
    { refreshPage: intent !== "delete" },
  );
}

/** Publish the draft as it is. */
export async function publishWikiPage(
  documentId: unknown,
  version: unknown,
): Promise<WikiPageActionResult> {
  return transition("publish", documentId, version);
}

/** Withdraw the published page (moderators). */
export async function unpublishWikiPage(
  documentId: unknown,
  version: unknown,
): Promise<WikiPageActionResult> {
  return transition("unpublish", documentId, version);
}

/** Revert the draft to the published version; without one, delete the page (author, moderators). */
export async function discardWikiPage(
  documentId: unknown,
  version: unknown,
): Promise<WikiPageActionResult> {
  return transition("discardDraft", documentId, version);
}

/** Delete the page (moderators). */
export async function deleteWikiPage(
  documentId: unknown,
  version: unknown,
): Promise<WikiPageActionResult> {
  return transition("delete", documentId, version);
}

/**
 * Restore a revision of the page's history and publish it (one
 * transaction, one If-Match). A revision of another page answers 404.
 */
export async function restoreWikiRevision(
  documentId: unknown,
  version: unknown,
  revisionId: unknown,
): Promise<WikiPageActionResult> {
  const gate = await wikiContext();
  if (!gate.ok) return gate.failure;
  if (gate.context.capabilities.wikiPages.edit === "none") return actionFailure("forbidden");
  if (!validReference(documentId, version) || !isRevisionId(revisionId)) {
    return actionFailure("invalid");
  }
  return wikiPageWrite(
    "restore",
    { documentId, version: version as string, revisionId },
    { refreshPage: true },
  );
}
