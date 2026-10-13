import "server-only";

import { refresh } from "next/cache";
import type { AuthoringResult, AuthoringWriteStatus } from "@sinnlos/domain";
import { actionFailure, runCmsAction, type ActionResult } from "@/lib/action-result";
import {
  sendAuthoringWrite,
  type AuthoringWriteIntent,
  type AuthoringWriteRequest,
} from "@/lib/api/manage/authoring";
import { appTimeZone } from "@/lib/app-time-zone";
import { isDocumentId } from "@/lib/entry-id";
import { capabilitiesFor, type AuthoringVerb } from "@/lib/roles";
import { getViewer, type Viewer } from "@/lib/viewer";
import { areaAccess, canDo, lacksDepartment, type AreaAccess } from "./access";
import { AREA_TYPE, type ManageArea } from "./areas";
import type { BuiltPayload, PayloadContext } from "./payload";

/**
 * The shared steps of every /manage Server Action (deep-dive decision 06
 * §L3, AC01): the capability check, then (in the area's action) the domain
 * checks, the date conversion and the payload, then one authoring request
 * with an explicit `status` and `If-Match: "<version>"`
 * (lib/api/manage/authoring.ts), mapped to an ActionResult by runCmsAction:
 *   400 → invalid + fields (details.keys/codes), 403 → forbidden,
 *   404 → notFound, 412 → conflict + version (details.current),
 *   428 → failed (logged as an error: a web bug), 5xx/network → unavailable,
 *   401 with a session → the sign-in redirect, rethrown.
 * No Strapi message reaches the UI (AC02).
 *
 * Success data is the cms's write answer (K7 AuthoringResult: documentId,
 * version, status, publishedAt, the schedule fields), or null when the
 * document is gone (a delete; a moderator's discard of a draft that was
 * never published).
 */

export type AuthoringActionResult = ActionResult<never, AuthoringResult | null>;

/** A version as the cms answers it: a decimal revision (K7). */
const VERSION_RE = /^\d{1,9}$/;

export function isVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION_RE.test(value);
}

export function isWriteStatus(value: unknown): value is AuthoringWriteStatus {
  return value === "draft" || value === "published";
}

export interface AuthorContext {
  viewer: Viewer;
  access: AreaAccess;
}

/**
 * Step 1: the viewer may use `verbs` in `area` (capabilities, SH02). The
 * viewer is read fresh per action (getViewer, D-SESSION-01): an unreadable
 * one (CMS outage) is "unavailable", a role without the verbs, or a
 * department author without a department (§N1), "forbidden". Nothing is
 * sent in either case.
 */
export async function authorContext(
  area: ManageArea,
  verbs: readonly AuthoringVerb[],
): Promise<{ ok: true; context: AuthorContext } | { ok: false; failure: AuthoringActionResult }> {
  const viewer = await getViewer();
  if (viewer.id === null) return { ok: false, failure: actionFailure("unavailable") };
  const access = areaAccess(capabilitiesFor(viewer.role), area);
  if (!access || !verbs.every((verb) => canDo(access, verb))) {
    return { ok: false, failure: actionFailure("forbidden") };
  }
  if (lacksDepartment(access, viewer.department)) {
    return { ok: false, failure: actionFailure("forbidden") };
  }
  return { ok: true, context: { viewer, access } };
}

/** The payload context of a save by `context`'s viewer. */
export function payloadContext(
  context: AuthorContext,
  mode: PayloadContext["mode"],
  retarget: boolean,
): PayloadContext {
  return {
    mode,
    roleClass: context.access.roleClass,
    timeZone: appTimeZone(),
    now: Date.now(),
    ownDepartment:
      context.access.roleClass === "departmentAuthor"
        ? (context.viewer.department?.documentId ?? null)
        : null,
    retarget,
  };
}

/** A local refusal of a built payload (field → code), or null. */
export function payloadFailure(built: BuiltPayload): AuthoringActionResult | null {
  return built.ok ? null : actionFailure("invalid", { fields: built.fields });
}

/** Whether the document reference and version of a mutation are well-formed. */
export function validReference(documentId: unknown, version: unknown): documentId is string {
  return isDocumentId(documentId) && isVersion(version);
}

/**
 * The authoring request itself (§L3 steps 5-6). `refresh` re-renders the
 * page the action came from with the new state (an edit page: its badges
 * and `editable`); a create or a delete navigates instead, so it passes
 * false (a refresh would first re-render the page the author leaves).
 */
export function authoringWrite(
  area: ManageArea,
  intent: AuthoringWriteIntent,
  request: AuthoringWriteRequest,
  { refreshPage }: { refreshPage: boolean },
): Promise<AuthoringActionResult> {
  return runCmsAction<
    never,
    Awaited<ReturnType<typeof sendAuthoringWrite>>,
    AuthoringResult | null
  >(() => sendAuthoringWrite(AREA_TYPE[area], intent, request), {
    label: `[manage-${area}] ${intent}`,
    // Only while the document still exists: a discard that removed a
    // never-published draft navigates away like a delete.
    after: refreshPage ? (answer) => (answer ? refresh() : undefined) : undefined,
    data: (answer) => answer?.data ?? null,
  });
}

/** The verbs a save needs: create or edit, plus publish for a save that publishes. */
export function saveVerbs(
  mode: "create" | "update",
  publishes: boolean,
  schedules: boolean,
): AuthoringVerb[] {
  const verbs: AuthoringVerb[] = [mode === "create" ? "create" : "edit"];
  if (publishes) verbs.push("publish");
  if (schedules) verbs.push("schedule");
  return verbs;
}

/** The verb of a state transition. */
export const TRANSITION_VERB: Readonly<
  Record<"publish" | "unpublish" | "discardDraft" | "delete", AuthoringVerb>
> = {
  publish: "publish",
  unpublish: "unpublish",
  discardDraft: "discard",
  delete: "delete",
};

/**
 * publish, unpublish, discard-draft or delete of one item: capability,
 * reference, then the request with If-Match. A delete does not refresh (the
 * form navigates to the list).
 */
export async function transitionItem(
  area: ManageArea,
  intent: keyof typeof TRANSITION_VERB,
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  const gate = await authorContext(area, [TRANSITION_VERB[intent]]);
  if (!gate.ok) return gate.failure;
  if (!validReference(documentId, version)) return actionFailure("invalid");
  return authoringWrite(
    area,
    intent,
    { documentId, version: version as string },
    { refreshPage: intent !== "delete" },
  );
}
