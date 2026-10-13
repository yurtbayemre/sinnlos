import { errors } from "@strapi/utils";
import {
  DEPARTMENT_AUTHOR_ROLES,
  MODERATORS,
  STAFF_ROLES,
  hasRole,
  type RoleType,
} from "../bootstrap/roles";
import {
  ANNOUNCEMENT_UID,
  AUTHORED_UIDS,
  DEPARTMENT_AUTHORED_UIDS,
  DOCUMENT_UID,
  EVENT_UID,
  QUICK_LINK_UID,
} from "./authoring-uids";
import {
  authoringChecks,
  type AuthoringChecksHost,
  type CallerDepartment,
} from "./authoring-checks";
import { readRevision, type DocumentLockHost, type ScopeClassifier } from "./document-lock";
import { parseEntryRef } from "./entry-id";
import { identifiedCaller, type PolicyCaller } from "./policy-factories";
import { publishBlockers, type PublishReadinessHost } from "./publish-readiness";
import {
  DEPARTMENT_AUTHOR_CLASS,
  MODERATOR_CLASS,
  POLL_UID,
  USER_UID,
  enforceWriteAllowlist,
  hasTargetId,
  type WritePolicyContext,
} from "./write-allowlist";

/**
 * The v2 write gate (deep-dive decision 06 §B2, §N1, §N3, §N8; batch 15
 * plan item 4): global::can-author (policies/can-author.ts) on every
 * authoring route of announcement, event, quick-link, document and poll,
 * configured with the route's `{ uid }` and, for the custom actions, its
 * `intent`. In order:
 *
 *   1. no signed-in user, one without a numeric id, a route without a uid
 *      of AUTHORED_UIDS or an unknown intent: no class;
 *   2. the role class (§B2, §N1): admin_role and editor are `moderator` on
 *      every authored type; a `department_head` (DEPARTMENT_AUTHOR_ROLES) is
 *      `departmentAuthor` on announcement, event and document only, and
 *      only with a `user.department`, read per request with one query (the
 *      loader of can-edit-department.ts). Everyone else has none;
 *   3. a document intent (update, publish, unpublish, discardDraft,
 *      editable) loads the CANONICAL DRAFT (loadAuthoringRows): the ref is
 *      parsed before any query (row id or documentId, PL01), a row id is
 *      translated to its documentId, the document's revision is read
 *      BEFORE any content row (`observedRevision`, §G), then every row of
 *      the document, draft and published twin. A missing draft: no class.
 *      For `departmentAuthor`, every row must be owned by the caller's
 *      department and lie in its scope (§N3); otherwise no class;
 *   4. create and update: exactly one enforceWriteAllowlist() call with the
 *      class's rule, the stored draft and published twin (normalised, for
 *      crossCheck, the targeting derivations and frozenWhen), the relation,
 *      list, role, media and vote checks (utils/authoring-checks.ts), the
 *      caller's department and the readiness check. The status is left to
 *      the authoring controller (explicit per type, §B3);
 *   5. strict booleans: no class answers false (403) on the generic create
 *      and update and on the list, and throws NotFoundError (404) on the
 *      custom document actions, like a hidden findOne (S2.6, §B5). A 400
 *      comes only from the allowlist.
 *
 * What it decides travels to the controller on `ctx.state.authoring`
 * (AuthoringGate): the class, the caller's department, the document, its
 * `observedRevision`, the loaded rows and the classifier. The controller
 * puts the revision and the classifier into the authoring scope, and the
 * document lock accepts a write only when the locked revision equals both
 * the client's `If-Match` and `observedRevision`; on a mismatch it runs the
 * classifier again under the lock, so a caller whose class went away
 * (a moderator widened the item, the department was deleted, the head was
 * demoted) gets 403/404, never 412, and never a newer revision (amendment
 * row A2).
 *
 * NOT LOCKED (§G2): the caller's own role and department, and a team's
 * department. A concurrent permission change races like any request.
 */

export type GateIntent =
  "create" | "update" | "publish" | "unpublish" | "discardDraft" | "editable" | "authoringList";

const DOCUMENT_INTENTS: readonly GateIntent[] = [
  "update",
  "publish",
  "unpublish",
  "discardDraft",
  "editable",
];
const CUSTOM_INTENTS: readonly GateIntent[] = [
  "publish",
  "unpublish",
  "discardDraft",
  "editable",
  "authoringList",
];

export type AuthoringRoleClass = typeof MODERATOR_CLASS | typeof DEPARTMENT_AUTHOR_CLASS;

/** One stored row as loadAuthoringRows reads it (relations populated). */
export interface AuthoringRow {
  id: number;
  documentId: string;
  publishedAt?: unknown;
  [field: string]: unknown;
}

/** Every row of a document: the draft and, when published, its twin. */
export interface AuthoringRows {
  documentId: string;
  draft: AuthoringRow | null;
  published: AuthoringRow | null;
}

/** What the gate hands the authoring controller (`ctx.state.authoring`). */
export interface AuthoringGate {
  uid: string;
  intent: GateIntent;
  roleClass: AuthoringRoleClass;
  callerId: number;
  callerDepartment: CallerDepartment | null;
  /** Document intents only. */
  documentId?: string;
  observedRevision?: number;
  rows?: AuthoringRows;
  classify?: ScopeClassifier;
}

/** The ctx.state key the gate writes and the controller reads. */
export const AUTHORING_STATE_KEY = "authoring";

/** The slice of Strapi the gate uses. */
export type WriteGateHost = AuthoringChecksHost & DocumentLockHost & PublishReadinessHost;

// ---------------------------------------------------------------------------
// Rows

const DEPARTMENT_REF = { select: ["id", "documentId", "name"] };

/** The relations each type's gate, list and form read (never a client populate). */
export const AUTHORING_POPULATE: Readonly<Record<string, Record<string, unknown>>> = {
  [ANNOUNCEMENT_UID]: {
    department: DEPARTMENT_REF,
    team: { select: ["id", "documentId", "name"], populate: { department: { select: ["id"] } } },
    audienceRoles: { select: ["id", "documentId", "type"] },
    ownerDepartment: DEPARTMENT_REF,
    author: { select: ["id", "displayName", "username"] },
  },
  [EVENT_UID]: {
    departments: DEPARTMENT_REF,
    ownerDepartment: DEPARTMENT_REF,
    organizer: { select: ["id", "displayName", "username"] },
  },
  [QUICK_LINK_UID]: { departments: DEPARTMENT_REF },
  [DOCUMENT_UID]: {
    departments: DEPARTMENT_REF,
    ownerDepartment: DEPARTMENT_REF,
    uploadedBy: { select: ["id", "displayName", "username"] },
    file: { select: ["id", "name", "mime", "size", "url"] },
  },
  [POLL_UID]: {
    departments: DEPARTMENT_REF,
    author: { select: ["id", "displayName", "username"] },
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRow = (value: unknown): value is AuthoringRow =>
  isRecord(value) && typeof value.id === "number" && typeof value.documentId === "string";

/** Every row of `documentId` with the type's relations, split into draft and published. */
export async function loadDocumentRows(
  strapi: Pick<WriteGateHost, "db">,
  uid: string,
  documentId: string,
): Promise<AuthoringRows> {
  const rows = (await strapi.db.query(uid).findMany({
    where: { documentId },
    populate: AUTHORING_POPULATE[uid] ?? {},
  })) as unknown[];
  const list = (Array.isArray(rows) ? rows : []).filter(isRow);
  return {
    documentId,
    draft: list.find((row) => row.publishedAt == null) ?? null,
    published: list.find((row) => row.publishedAt != null) ?? null,
  };
}

/**
 * The canonical draft loader (§B2 step 3): the document a route id names,
 * its revision read BEFORE its rows, and the rows. null for a malformed
 * ref, a missing document and a document without a draft row.
 */
export async function loadAuthoringRows(
  strapi: Pick<WriteGateHost, "db">,
  uid: string,
  idParam: unknown,
): Promise<{ observedRevision: number; rows: AuthoringRows } | null> {
  const ref = parseEntryRef(idParam);
  if (!ref) return null;
  let documentId: string;
  if ("documentId" in ref) {
    documentId = ref.documentId;
  } else {
    // A row id (either twin's) names its document.
    const row = (await strapi.db.query(uid).findOne({
      where: { id: ref.id },
      select: ["id", "documentId"],
    })) as unknown;
    if (!isRow(row)) return null;
    documentId = row.documentId;
  }
  // Before any content row (amendment row A2): the rows read below are at
  // least this new, because every change to them advances the revision in
  // the same transaction.
  const observedRevision = await readRevision(strapi as DocumentLockHost, uid, documentId);
  const rows = await loadDocumentRows(strapi, uid, documentId);
  if (!rows.draft) return null;
  return { observedRevision, rows };
}

// ---------------------------------------------------------------------------
// Department authors (§N1, §N3)

const relationId = (value: unknown): number | null =>
  isRecord(value) && typeof value.id === "number" ? value.id : null;

const relationIds = (value: unknown): number[] =>
  Array.isArray(value) ? value.map(relationId).filter((id): id is number => id !== null) : [];

/**
 * Whether one row lies in department `department`'s scope and is owned by
 * it (§N3):
 *   - every type: `ownerDepartment` is the department;
 *   - announcement: `department` is it; `team` null or a team of it;
 *     audience roles only staff role types (they only narrow);
 *   - event and document: `departments` exactly that one department.
 */
export function rowInDepartmentScope(
  uid: string,
  row: AuthoringRow,
  department: CallerDepartment,
): boolean {
  if (relationId(row.ownerDepartment) !== department.id) return false;
  if (uid === ANNOUNCEMENT_UID) {
    if (relationId(row.department) !== department.id) return false;
    if (row.team != null) {
      const team = isRecord(row.team) ? row.team : null;
      if (!team || relationId(team.department) !== department.id) return false;
    }
    const roles = Array.isArray(row.audienceRoles) ? row.audienceRoles : [];
    return roles.every(
      (role) =>
        isRecord(role) &&
        typeof role.type === "string" &&
        (STAFF_ROLES as readonly string[]).includes(role.type),
    );
  }
  if (uid === EVENT_UID || uid === DOCUMENT_UID) {
    const ids = relationIds(row.departments);
    return ids.length === 1 && ids[0] === department.id;
  }
  return false;
}

/** The department-author class on a document: every row owned and in scope (§N3). */
export function departmentAuthorOwns(
  uid: string,
  rows: AuthoringRows,
  department: CallerDepartment | null,
): boolean {
  if (!department || !(DEPARTMENT_AUTHORED_UIDS as readonly string[]).includes(uid)) return false;
  if (!rows.draft) return false;
  return [rows.draft, rows.published]
    .filter((row): row is AuthoringRow => row !== null)
    .every((row) => rowInDepartmentScope(uid, row, department));
}

/** The caller's `user.department` (§N1), read per request; null without one. */
export async function loadCallerDepartment(
  strapi: Pick<WriteGateHost, "db">,
  callerId: number,
): Promise<CallerDepartment | null> {
  const user = (await strapi.db.query(USER_UID).findOne({
    where: { id: callerId },
    select: ["id"],
    populate: { department: { select: ["id", "documentId"] } },
  })) as unknown;
  const department = isRecord(user) ? user.department : null;
  return isRecord(department) &&
    typeof department.id === "number" &&
    typeof department.documentId === "string"
    ? { id: department.id, documentId: department.documentId }
    : null;
}

/** The class a role may hold on `uid` before any row is read (null: none). */
export function roleClassFor(
  user: PolicyCaller | null | undefined,
  uid: string,
): AuthoringRoleClass | null {
  if (hasRole(user, MODERATORS)) return MODERATOR_CLASS;
  if (
    hasRole(user, DEPARTMENT_AUTHOR_ROLES as readonly RoleType[]) &&
    (DEPARTMENT_AUTHORED_UIDS as readonly string[]).includes(uid)
  ) {
    return DEPARTMENT_AUTHOR_CLASS;
  }
  return null;
}

/**
 * The classifier the lock runs again under the lock on a mismatch (§G
 * mechanism step 3): re-reads the rows; no rows (the document is gone) or,
 * for a department author, a row out of their department's scope answers
 * null. The role and the department are not re-read (§G2 "not locked").
 */
export function scopeClassifier(
  strapi: Pick<WriteGateHost, "db">,
  roleClass: AuthoringRoleClass,
  callerDepartment: CallerDepartment | null,
): ScopeClassifier {
  return async ({ uid, documentId }) => {
    const rows = await loadDocumentRows(strapi, uid, documentId);
    if (!rows.draft) return null;
    if (roleClass === MODERATOR_CLASS) return MODERATOR_CLASS;
    return departmentAuthorOwns(uid, rows, callerDepartment) ? DEPARTMENT_AUTHOR_CLASS : null;
  };
}

// ---------------------------------------------------------------------------
// Normalised rows (the allowlist's `existing` and `published`)

const toIso = (value: unknown): unknown => (value instanceof Date ? value.toISOString() : value);

/**
 * A stored row as the allowlist reads it: scalars as stored (instants as
 * ISO-Z), to-one relations as a documentId or null, to-many relations as
 * documentIds, audience roles as role types, media as `{ id }`.
 */
export function normaliseRow(row: AuthoringRow | null): Record<string, unknown> | null {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "audienceRoles") {
      out[key] = Array.isArray(value)
        ? value
            .map((role) => (isRecord(role) ? role.type : null))
            .filter((type): type is string => typeof type === "string")
        : [];
    } else if (Array.isArray(value) && value.every(isRecord)) {
      out[key] = value
        .map((entry) => entry.documentId)
        .filter((id): id is string => typeof id === "string");
    } else if (isRecord(value) && !(value instanceof Date)) {
      out[key] =
        typeof value.documentId === "string"
          ? value.documentId
          : typeof value.id === "number"
            ? { id: value.id }
            : value;
    } else {
      out[key] = toIso(value);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The policy

export interface WriteGateConfig {
  /** The content type the route writes (route config). */
  uid?: unknown;
  /** The custom action this route serves; create/update when absent. */
  intent?: unknown;
}

/** The slice of the Strapi policy context the gate reads and writes. */
export interface WriteGateContext extends WritePolicyContext {
  state?: { user?: PolicyCaller | null; [key: string]: unknown };
  params?: { id?: unknown };
}

const KNOWN_INTENTS: readonly GateIntent[] = [
  "create",
  "update",
  "publish",
  "unpublish",
  "discardDraft",
  "editable",
  "authoringList",
];

/** The intent a route config names (create/update by the route id when none). */
function intentOf(config: WriteGateConfig | undefined, idParam: unknown): GateIntent | null {
  if (config?.intent === undefined) return hasTargetId(idParam) ? "update" : "create";
  return KNOWN_INTENTS.includes(config.intent as GateIntent) ? (config.intent as GateIntent) : null;
}

/** No class: false on the generic routes and the list, 404 on a custom document action. */
function refuse(intent: GateIntent | null): false {
  if (intent !== null && intent !== "authoringList" && CUSTOM_INTENTS.includes(intent)) {
    throw new errors.NotFoundError("Not Found");
  }
  return false;
}

/** global::can-author (see the module comment). */
export function writeGate() {
  return async (
    policyContext: WriteGateContext,
    config: WriteGateConfig | undefined,
    { strapi }: { strapi: WriteGateHost },
  ): Promise<boolean> => {
    const idParam = policyContext.params?.id;
    const intent = intentOf(config, idParam);
    const caller = identifiedCaller(policyContext.state?.user);
    const uid = typeof config?.uid === "string" ? config.uid : null;
    // A route without its uid (or an unknown one) is a wiring bug: refuse.
    if (!intent || !caller || !uid || !(AUTHORED_UIDS as readonly string[]).includes(uid)) {
      return refuse(intent);
    }
    const roleClass = roleClassFor(caller, uid);
    if (!roleClass) return refuse(intent);

    let callerDepartment: CallerDepartment | null = null;
    if (roleClass === DEPARTMENT_AUTHOR_CLASS) {
      callerDepartment = await loadCallerDepartment(strapi, caller.id);
      // A department head without a department authors nothing (§N1).
      if (!callerDepartment) return refuse(intent);
    }

    const gate: AuthoringGate = {
      uid,
      intent,
      roleClass,
      callerId: caller.id,
      callerDepartment,
    };

    let loaded: { observedRevision: number; rows: AuthoringRows } | null = null;
    if (DOCUMENT_INTENTS.includes(intent)) {
      loaded = await loadAuthoringRows(strapi, uid, idParam);
      if (!loaded) return refuse(intent);
      if (
        roleClass === DEPARTMENT_AUTHOR_CLASS &&
        !departmentAuthorOwns(uid, loaded.rows, callerDepartment)
      ) {
        return refuse(intent);
      }
      gate.documentId = loaded.rows.documentId;
      gate.observedRevision = loaded.observedRevision;
      gate.rows = loaded.rows;
      gate.classify = scopeClassifier(strapi, roleClass, callerDepartment);
    }

    if (intent === "create" || intent === "update") {
      const rows = loaded?.rows ?? null;
      const ownRowIds = rows
        ? [rows.draft, rows.published]
            .filter((row): row is AuthoringRow => row !== null)
            .map((row) => row.id)
        : [];
      const passed = await enforceWriteAllowlist(
        policyContext,
        { uid, action: intent, roleClass },
        {
          callerId: caller.id,
          existing: normaliseRow(rows?.draft ?? null),
          published: normaliseRow(rows?.published ?? null),
          callerDepartment,
          readiness: (merged) => publishBlockers(strapi, uid, { ...merged }),
          ...authoringChecks(strapi, {
            callerId: caller.id,
            callerDepartment,
            uid,
            documentId: rows?.documentId,
            ownRowIds,
          }),
        },
        { status: "controller" },
      );
      if (!passed) return false;
    }

    const state = policyContext.state;
    if (!state) return false;
    state[AUTHORING_STATE_KEY] = gate;
    return true;
  };
}

/** The gate's decision on a request (the authoring controller reads it). */
export function authoringGateOf(state: unknown): AuthoringGate | null {
  if (!isRecord(state)) return null;
  const gate = state[AUTHORING_STATE_KEY];
  return isRecord(gate) && typeof gate.uid === "string" && typeof gate.roleClass === "string"
    ? (gate as unknown as AuthoringGate)
    : null;
}
