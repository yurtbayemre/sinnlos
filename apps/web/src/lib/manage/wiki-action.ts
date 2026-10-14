import "server-only";

import { refresh } from "next/cache";
import type { WikiEditorClass, WikiPageResult, WikiSpaceResult } from "@sinnlos/domain";
import { actionFailure, runCmsAction, type ActionResult } from "@/lib/action-result";
import {
  sendWikiPageWrite,
  sendWikiSpaceWrite,
  type WikiPageWriteIntent,
  type WikiPageWriteRequest,
  type WikiSpaceWriteIntent,
  type WikiWriteRequest,
} from "@/lib/api/manage/wiki";
import { capabilitiesFor, type Capabilities } from "@/lib/roles";
import { getViewer, type Viewer } from "@/lib/viewer";

/**
 * The shared steps of the wiki's Server Actions (deep-dive decision 06
 * §J1, §J2, §L3; batch 16 plan, lane 16C items 4-6), like
 * lib/manage/authoring-action.ts for the K7 types: the capability check
 * (the viewer read per action, D-SESSION-01), then the request through
 * lib/api/manage/wiki.ts, mapped to an AC01 ActionResult by runCmsAction
 * (400 → invalid + fields, 403 → forbidden, 404 → notFound, 412 →
 * conflict + version, 428 → failed and logged, 5xx/network → unavailable,
 * 401 with a session → the sign-in redirect, rethrown). No Strapi message
 * reaches the UI (AC02).
 *
 * The capabilities are role-only (lib/roles.ts): `wikiPages.create`
 * (department heads, team leads, moderators), `.edit` ("row" for the row
 * classes, "any" for moderators), `.unpublish`, `.schedule` and `.delete`
 * (moderators). The cms decides the row: a page the caller has no class on
 * answers 404 on the custom actions and 403 on the generic PUT.
 */

export type WikiPageActionResult = ActionResult<never, WikiPageResult | null>;
export type WikiSpaceActionResult = ActionResult<never, WikiSpaceResult | null>;

export interface WikiContext {
  viewer: Viewer;
  capabilities: Capabilities;
}

/** The viewer and their capabilities, or the failure (an unreadable viewer is unavailable). */
export async function wikiContext(): Promise<
  { ok: true; context: WikiContext } | { ok: false; failure: ActionResult<never, never> }
> {
  const viewer = await getViewer();
  if (viewer.id === null) return { ok: false, failure: actionFailure("unavailable") };
  return { ok: true, context: { viewer, capabilities: capabilitiesFor(viewer.role) } };
}

/**
 * The class a wiki page payload is built for: moderators their own; every
 * other role the row list (author, departmentHead and teamLead carry the
 * same keys; a create by a department head or team lead is `author`).
 */
export function wikiPageClass(capabilities: Capabilities): WikiEditorClass {
  return capabilities.wikiPages.edit === "any" ? "moderator" : "author";
}

/** A positive revision id of the history (an integer). */
export function isRevisionId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647;
}

/**
 * One wiki write, answered with its `data` (null: the item is gone).
 * `refreshPage`: re-render the page the action came from, while the item
 * still exists.
 */
function wikiWrite<R>(
  label: string,
  send: () => Promise<{ data: R } | undefined>,
  refreshPage: boolean,
): Promise<ActionResult<never, R | null>> {
  return runCmsAction<never, { data: R } | undefined, R | null>(send, {
    label: `[manage-wiki] ${label}`,
    after: refreshPage ? (answer) => (answer ? refresh() : undefined) : undefined,
    data: (answer) => answer?.data ?? null,
  });
}

/** One wiki-page write. */
export function wikiPageWrite(
  intent: WikiPageWriteIntent,
  request: WikiPageWriteRequest,
  { refreshPage }: { refreshPage: boolean },
): Promise<WikiPageActionResult> {
  return wikiWrite(`page ${intent}`, () => sendWikiPageWrite(intent, request), refreshPage);
}

/** One wiki-space write. */
export function wikiSpaceWrite(
  intent: WikiSpaceWriteIntent,
  request: WikiWriteRequest,
  { refreshPage }: { refreshPage: boolean },
): Promise<WikiSpaceActionResult> {
  return wikiWrite(`space ${intent}`, () => sendWikiSpaceWrite(intent, request), refreshPage);
}
