import {
  WIKI_PAGE_CREATOR_ROLES,
  WIKI_ROW_EDITOR_ROLES,
  classifyWikiEditor,
  type WikiEditPage,
  type WikiEditViewer,
  type WikiEditorClass,
} from "@sinnlos/domain";
import { errors } from "@strapi/utils";

import { MODERATORS, hasRole } from "../bootstrap/roles";
import { WIKI_PAGE_UID } from "./authoring-uids";
import { authoringChecks } from "./authoring-checks";
import type { ScopeClassifier } from "./document-lock";
import { identifiedCaller } from "./policy-factories";
import { publishBlockers } from "./publish-readiness";
import { loadUserScope, visibleWikiSpaceIds } from "./visible-ids";
import { pageSpace, wikiRelationChecks, type WikiWriteScope } from "./wiki-write-targets";
import {
  MODERATOR_CLASS,
  enforceWriteAllowlist,
  hasTargetId,
  type StrapiDb,
} from "./write-allowlist";
import {
  AUTHORING_STATE_KEY,
  loadAuthoringRows,
  loadDocumentRows,
  type AuthoringGate,
  type AuthoringRow,
  type AuthoringRows,
  type WriteGateConfig,
  type WriteGateContext,
  type WriteGateHost,
  normaliseRow,
  scopeClassifier,
} from "./write-gate";

/**
 * global::can-edit-wiki rebuilt on the v2 write gate (deep-dive decision
 * 06 §B2, §J2; batch 16 plan, lane 16B item 3; policy kind
 * `row-write-gate`). The bypass of admin_role and editor ends: they are the
 * `moderator` class, and their payloads go through the allowlist like
 * everyone's (utils/write-allowlist.ts, the wiki-page rules).
 *
 * Every route of api/wiki-page carries it with `{ uid }` and, on a custom
 * action, its `intent`; a route without the wiki-page uid gets no class.
 *
 *   1. no signed-in user, one without a numeric id, a wrong uid or an
 *      unknown intent: no class;
 *   2. the classes:
 *      - `create` and `createDraft` (no row): moderators are `moderator`,
 *        department heads and team leads (the create grant) `author`;
 *      - `authoringList` and `unpublish`: moderators only;
 *      - `myDrafts`: every role that holds the wiki-page update grant;
 *      - every action on a page (`update`, `saveDraft`, `editable`,
 *        `publish`, `discardDraft`, `unpublish`, `revisions`, `revision`,
 *        `restore`): the CANONICAL DRAFT is loaded (a row id is translated,
 *        PL01/S24; the revision is read before the rows, §G) with its
 *        published twin, and the caller's class is decided by
 *        @sinnlos/domain classifyWikiEditor on EVERY row (S3): `moderator`,
 *        or `author`, `departmentHead`, `teamLead`, the first match, on the
 *        draft and the published row alike. A non-moderator also needs the
 *        page to sit in one space they can read;
 *   3. `create`, `createDraft`, `update` and `saveDraft`: exactly one
 *      enforceWriteAllowlist() call with the class's rule, the wiki relation
 *      checks (the readable space and parent; a moderator reads every
 *      space), the department and team checks, the stored draft (the
 *      schedule check, the early publish readiness) and its parent (the
 *      early loop walk runs only when the payload changes the parent). The
 *      author classes stay pinned to `status=published` on the generic
 *      create and update (FX07); moderators name the status, and the draft
 *      actions never publish (the controller);
 *   4. no class: false (403) on the generic create and update, the list and
 *      myDrafts; NotFoundError (404) on the custom page actions, like a
 *      hidden page (S2.6).
 *
 * The decision travels on `ctx.state.authoring` (the AuthoringGate of
 * write-gate.ts), with the classifier the document lock runs again under
 * the lock: on every scoped mutation the rows are re-read and classified
 * with the same caller (role, department, readable spaces: not locked,
 * §G2), so a class lost between the gate and the lock answers 403/404,
 * never 412.
 *
 * Discarding a page without a published row deletes it: only its author
 * and moderators may (§J2), decided by the controller under the lock.
 */

export type WikiGateIntent =
  | "create"
  | "update"
  | "createDraft"
  | "myDrafts"
  | "editable"
  | "saveDraft"
  | "publish"
  | "discardDraft"
  | "unpublish"
  | "authoringList"
  | "revisions"
  | "revision"
  | "restore";

const KNOWN_INTENTS: readonly WikiGateIntent[] = [
  "create",
  "update",
  "createDraft",
  "myDrafts",
  "editable",
  "saveDraft",
  "publish",
  "discardDraft",
  "unpublish",
  "authoringList",
  "revisions",
  "revision",
  "restore",
];

/** The actions on one page: the canonical draft is loaded and classified. */
const PAGE_INTENTS: readonly WikiGateIntent[] = [
  "update",
  "saveDraft",
  "editable",
  "publish",
  "discardDraft",
  "unpublish",
  "revisions",
  "revision",
  "restore",
];

/** The custom page actions: no class answers 404, like a hidden page. */
const NOT_FOUND_INTENTS: readonly WikiGateIntent[] = PAGE_INTENTS.filter(
  (intent) => intent !== "update",
);

const MODERATOR_INTENTS: readonly WikiGateIntent[] = ["unpublish", "authoringList"];

/** The writes and the allowlist action each one checks against. */
const WRITE_INTENTS: Readonly<Partial<Record<WikiGateIntent, "create" | "update">>> = {
  create: "create",
  createDraft: "create",
  update: "update",
  saveDraft: "update",
};

/** Every role that holds the wiki-page update grant (myDrafts). */
const WIKI_UPDATER_ROLES = [...MODERATORS, ...WIKI_ROW_EDITOR_ROLES];

/** What the wiki gate adds to the AuthoringGate. */
export interface WikiGateExtras {
  /** The caller as classifyWikiEditor reads it. */
  viewer: WikiEditViewer;
  /** The wiki-space row ids the caller reads; null for moderators (every space). */
  visibleSpaceIds: ReadonlySet<number> | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const relationId = (value: unknown): number | null =>
  isRecord(value) && typeof value.id === "number" ? value.id : null;

const relationDocumentId = (value: unknown): string | null =>
  isRecord(value) && typeof value.documentId === "string" ? value.documentId : null;

/** One stored page row as classifyWikiEditor reads it (AUTHORING_POPULATE of wiki-page). */
export function wikiEditPageOf(row: AuthoringRow): WikiEditPage {
  return {
    authorId: relationId(row.author),
    departmentId: relationId(row.department),
    teamLeadId: isRecord(row.team) ? relationId(row.team.lead) : null,
  };
}

/**
 * The caller's class on a page: classifyWikiEditor on every row (the draft
 * and, when published, its twin), the draft's class when every row gives
 * one; a non-moderator also needs every row in one space they read.
 */
export async function wikiRowClass(
  strapi: StrapiDb,
  extras: WikiGateExtras,
  rows: AuthoringRows,
): Promise<WikiEditorClass | null> {
  if (!rows.draft) return null;
  const classes = [rows.draft, rows.published]
    .filter((row): row is AuthoringRow => row !== null)
    .map((row) => classifyWikiEditor(extras.viewer, wikiEditPageOf(row)));
  const [draftClass] = classes;
  if (!draftClass || classes.some((roleClass) => roleClass === null)) return null;
  if (draftClass === MODERATOR_CLASS) return draftClass;
  return (await pageSpace(strapi, rows.documentId, extras.visibleSpaceIds)) ? draftClass : null;
}

/** The classifier the document lock runs again under the lock (the same caller). */
export function wikiScopeClassifier(
  strapi: WriteGateHost,
  roleClass: WikiEditorClass,
  extras: WikiGateExtras,
): ScopeClassifier {
  // A moderator's class depends on the role alone: one count asks whether the page is there.
  if (roleClass === MODERATOR_CLASS) return scopeClassifier(strapi, MODERATOR_CLASS, null);
  return async ({ uid, documentId }) =>
    wikiRowClass(
      strapi as unknown as StrapiDb,
      extras,
      await loadDocumentRows(strapi, uid, documentId),
    );
}

function intentOf(config: WriteGateConfig | undefined, idParam: unknown): WikiGateIntent | null {
  if (config?.intent === undefined) return hasTargetId(idParam) ? "update" : "create";
  return KNOWN_INTENTS.includes(config.intent as WikiGateIntent)
    ? (config.intent as WikiGateIntent)
    : null;
}

/** No class: false on the generic routes and the lists, 404 on a custom page action. */
function refuse(intent: WikiGateIntent | null): false {
  if (intent !== null && NOT_FOUND_INTENTS.includes(intent)) {
    throw new errors.NotFoundError("Not Found");
  }
  return false;
}

/** The caller's department id and readable spaces (non-moderators; read per request). */
async function callerScope(
  strapi: WriteGateHost,
  caller: { id: number; role?: { type?: unknown } | null },
  moderator: boolean,
): Promise<WikiGateExtras> {
  const role = typeof caller.role?.type === "string" ? caller.role.type : null;
  if (moderator) {
    return { viewer: { role, userId: caller.id, departmentId: null }, visibleSpaceIds: null };
  }
  const scope = await loadUserScope(strapi, caller.id);
  return {
    viewer: { role, userId: caller.id, departmentId: scope.departmentId ?? null },
    visibleSpaceIds: new Set(await visibleWikiSpaceIds(strapi, scope)),
  };
}

/** global::can-edit-wiki (see the module comment). */
export function wikiPageGate() {
  return async (
    policyContext: WriteGateContext,
    config: WriteGateConfig | undefined,
    { strapi }: { strapi: WriteGateHost },
  ): Promise<boolean> => {
    const idParam = policyContext.params?.id;
    const intent = intentOf(config, idParam);
    const caller = identifiedCaller(policyContext.state?.user);
    // A route without the wiki-page uid is a wiring bug: refuse.
    if (!intent || !caller || config?.uid !== WIKI_PAGE_UID) return refuse(intent);
    const moderator = hasRole(caller, MODERATORS);
    if (MODERATOR_INTENTS.includes(intent) && !moderator) return refuse(intent);
    const db = strapi as unknown as StrapiDb;

    let roleClass: WikiEditorClass;
    let extras: WikiGateExtras;
    let loaded: { observedRevision: number; rows: AuthoringRows } | null = null;
    if (intent === "authoringList") {
      roleClass = MODERATOR_CLASS;
      extras = await callerScope(strapi, caller, true);
    } else if (intent === "myDrafts") {
      if (!hasRole(caller, WIKI_UPDATER_ROLES)) return refuse(intent);
      roleClass = moderator ? MODERATOR_CLASS : "author";
      extras = await callerScope(strapi, caller, moderator);
    } else if (intent === "create" || intent === "createDraft") {
      if (!hasRole(caller, WIKI_PAGE_CREATOR_ROLES)) return refuse(intent);
      roleClass = moderator ? MODERATOR_CLASS : "author";
      extras = await callerScope(strapi, caller, moderator);
    } else {
      // The ref is parsed before any read: a malformed id costs no query.
      loaded = await loadAuthoringRows(strapi, WIKI_PAGE_UID, idParam);
      if (!loaded) return refuse(intent);
      extras = await callerScope(strapi, caller, moderator);
      const found = await wikiRowClass(db, extras, loaded.rows);
      if (!found) return refuse(intent);
      roleClass = found;
    }

    const gate: AuthoringGate & { wiki: WikiGateExtras } = {
      uid: WIKI_PAGE_UID,
      intent,
      roleClass,
      callerId: caller.id,
      callerDepartment: null,
      wiki: extras,
    };
    if (loaded) {
      gate.documentId = loaded.rows.documentId;
      gate.observedRevision = loaded.observedRevision;
      gate.rows = loaded.rows;
      gate.classify = wikiScopeClassifier(strapi, roleClass, extras);
    }

    const action = WRITE_INTENTS[intent];
    if (action) {
      const rows = loaded?.rows ?? null;
      const draft = rows?.draft ?? null;
      const scope: WikiWriteScope = { visibleSpaceIds: extras.visibleSpaceIds };
      if (rows && draft) {
        scope.pageDocumentId = rows.documentId;
        // The page's space: for a moderator the draft's (rows may differ
        // after a panel move), for the others the one readable space.
        const space =
          extras.visibleSpaceIds === null
            ? relationDocumentId(draft.space)
            : await pageSpace(db, rows.documentId, extras.visibleSpaceIds);
        scope.spaceDocumentId = space ?? undefined;
        scope.currentParentDocumentId = relationDocumentId(draft.parent);
      }
      const checks = authoringChecks(strapi, {
        callerId: caller.id,
        callerDepartment: null,
        uid: WIKI_PAGE_UID,
        documentId: rows?.documentId,
        ownRowIds: [],
      });
      const passed = await enforceWriteAllowlist(
        policyContext,
        { uid: WIKI_PAGE_UID, action, roleClass },
        {
          callerId: caller.id,
          existing: normaliseRow(draft),
          published: normaliseRow(rows?.published ?? null),
          readiness: (merged) => publishBlockers(strapi, WIKI_PAGE_UID, { ...merged }),
          relationChecks: {
            ...checks.relationChecks,
            ...wikiRelationChecks(db, scope),
          },
        },
        // The author classes' generic writes publish (FX07); everything
        // else leaves the status to the controller.
        {
          status: !moderator && (intent === "create" || intent === "update") ? "pin" : "controller",
        },
      );
      if (!passed) return false;
    }

    const state = policyContext.state;
    if (!state) return false;
    state[AUTHORING_STATE_KEY] = gate;
    return true;
  };
}

/** The wiki extras of a gate decision (the wiki controller reads them). */
export function wikiGateExtrasOf(gate: AuthoringGate | null): WikiGateExtras | null {
  const extras = (gate as (AuthoringGate & { wiki?: unknown }) | null)?.wiki;
  return isRecord(extras) && isRecord(extras.viewer) ? (extras as unknown as WikiGateExtras) : null;
}
