import type {
  DepartmentEditable,
  OrgAuthoringIntent,
  OrgEditorClass,
  OrgPersonRef,
  RoleType,
  TeamEditable,
} from "@sinnlos/domain";
import { ORG_AUTHORING_INTENTS } from "@sinnlos/domain";
import { errors } from "@strapi/utils";

import { hasRole } from "../bootstrap/roles";
import { authoringChecks, type CallerDepartment } from "./authoring-checks";
import {
  answering,
  documentIdOf,
  editableMediaOf,
  iso,
  noQuery,
  payloadOf,
  type AuthoringContext,
  type AuthoringControllerHost,
} from "./authoring-controller";
import { DEPARTMENT_UID, TEAM_UID } from "./authoring-uids";
import {
  etagOf,
  parseIfMatch,
  readRevision,
  runInAuthoringScope,
  type AuthoringScope,
  type ScopeClassifier,
} from "./document-lock";
import { parseEntryRef } from "./entry-id";
import { identifiedCaller, type PolicyCaller } from "./policy-factories";
import { getMutableQuery } from "./policy-query";
import { enforceWriteAllowlist, USER_UID } from "./write-allowlist";
import {
  loadCallerDepartment,
  normaliseRow,
  type AuthoringRow,
  type WriteGateContext,
  type WriteGateHost,
} from "./write-gate";

const STATE_KEY = "orgAuthoring";
type OrgIntent = OrgAuthoringIntent;
/** Structure (create, delete) is admin_role's alone (v0.22, deep-dive plan-org-users.md). */
const STRUCTURE_INTENTS: readonly OrgIntent[] = ["create", "delete"];
interface OrgGate {
  uid: string;
  intent: OrgIntent;
  /** null only for a create. */
  row: AuthoringRow | null;
  roleClass: OrgEditorClass;
  observedRevision: number;
  classify: ScopeClassifier;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const relationId = (value: unknown): number | null =>
  isRecord(value) && typeof value.id === "number" ? value.id : null;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const mediaField = (uid: string) => (uid === DEPARTMENT_UID ? "headerImage" : "avatar");
const PERSON = { select: ["id", "documentId", "displayName", "username"] };
/** What the editable DTO needs beyond the row: two counts. */
interface CountHost {
  db: { query(uid: string): { count(params: Record<string, unknown>): Promise<number> } };
}

/** A single org row, regardless of its legacy publishedAt value. */
async function loadRow(
  strapi: Pick<WriteGateHost, "db">,
  uid: string,
  documentId: string,
): Promise<AuthoringRow | null> {
  const row = await strapi.db.query(uid).findOne({
    where: { documentId },
    select: [
      "id",
      "documentId",
      "name",
      "slug",
      "description",
      "updatedAt",
      ...(uid === DEPARTMENT_UID ? ["color"] : []),
    ],
    populate: {
      [mediaField(uid)]: { select: ["id", "name", "mime", "size", "url"] },
      ...(uid === DEPARTMENT_UID
        ? { head: PERSON }
        : {
            lead: PERSON,
            department: { select: ["id", "documentId", "name"] },
            members: PERSON,
          }),
    },
  });
  return isRecord(row) && typeof row.id === "number" && typeof row.documentId === "string"
    ? (row as AuthoringRow)
    : null;
}

function rowClass(
  uid: string,
  row: AuthoringRow | null,
  caller: PolicyCaller & { id: number },
  department: CallerDepartment | null,
): OrgEditorClass | null {
  if (!row) return null;
  if (hasRole(caller, ["admin_role"])) return "moderator";
  // The existing lead right takes precedence, within the route's role grants.
  if (uid === TEAM_UID && relationId(row.lead) === caller.id) return "teamLead";
  if (
    hasRole(caller, ["department_head"]) &&
    department &&
    (uid === DEPARTMENT_UID ? row.id : relationId(row.department)) === department.id
  )
    return "departmentHead";
  return null;
}

/** Roles a route of `intent` admits at all; the row class decides the rest. */
function admittedRoles(uid: string, intent: OrgIntent): RoleType[] {
  if (STRUCTURE_INTENTS.includes(intent)) return ["admin_role"];
  return uid === DEPARTMENT_UID
    ? ["admin_role", "department_head"]
    : ["admin_role", "department_head", "team_lead"];
}

/** Shared by every org route; every admitted class passes the same field allowlist. */
export function orgGate(uid: string) {
  return async (
    ctx: WriteGateContext,
    config: { intent?: unknown } | undefined,
    { strapi }: { strapi: WriteGateHost },
  ): Promise<boolean> => {
    const intent = (config?.intent ?? "update") as OrgIntent;
    const refuse = (): false => {
      if (intent === "editable") throw new errors.NotFoundError("Not Found");
      return false;
    };
    const caller = identifiedCaller(ctx.state?.user);
    if (
      (uid !== DEPARTMENT_UID && uid !== TEAM_UID) ||
      !(ORG_AUTHORING_INTENTS as readonly string[]).includes(intent) ||
      !caller ||
      !hasRole(caller, admittedRoles(uid, intent))
    )
      return refuse();

    if (intent === "create") {
      noQuery(getMutableQuery(ctx));
      const passed = await enforceWriteAllowlist(
        ctx,
        { uid, action: "create", roleClass: "moderator" },
        {
          callerId: caller.id,
          existing: normaliseRow(null),
          ...authoringChecks(strapi, {
            uid,
            callerId: caller.id,
            callerDepartment: null,
            ownRowIds: [],
          }),
        },
        { status: "controller" },
      );
      if (!passed || !ctx.state) return false;
      ctx.state[STATE_KEY] = {
        uid,
        intent,
        row: null,
        roleClass: "moderator",
        observedRevision: 0,
        classify: async () => "moderator",
      } satisfies OrgGate;
      return true;
    }

    const ref = parseEntryRef(ctx.params?.id);
    if (!ref) return refuse();
    const identity =
      "documentId" in ref
        ? ref
        : await strapi.db.query(uid).findOne({ where: ref, select: ["documentId"] });
    if (!isRecord(identity) || typeof identity.documentId !== "string") return refuse();
    const documentId = identity.documentId;
    const observedRevision = await readRevision(strapi, uid, documentId);
    const row = await loadRow(strapi, uid, documentId);
    if (!row && intent === "delete") throw new errors.NotFoundError("Not Found");
    const department = hasRole(caller, ["department_head"])
      ? await loadCallerDepartment(strapi, caller.id)
      : null;
    const roleClass = rowClass(uid, row, caller, department);
    if (!row || !roleClass) return refuse();
    noQuery(getMutableQuery(ctx));
    if (
      intent === "update" &&
      !(await enforceWriteAllowlist(
        ctx,
        { uid, action: "update", roleClass },
        {
          callerId: caller.id,
          existing: normaliseRow(row),
          ...authoringChecks(strapi, {
            uid,
            documentId,
            callerId: caller.id,
            callerDepartment: department,
            ownRowIds: [row.id],
          }),
        },
        { status: "controller" },
      ))
    )
      return false;
    if (!ctx.state) return false;
    // shortcut: caller role/department changes can race this request, as with the existing authoring gates; revisit with directory locking.
    const classify: ScopeClassifier = async () =>
      rowClass(uid, await loadRow(strapi, uid, documentId), caller, department);
    ctx.state[STATE_KEY] = {
      uid,
      intent,
      row,
      roleClass,
      observedRevision,
      classify,
    } satisfies OrgGate;
    return true;
  };
}

function gateFor(ctx: AuthoringContext, uid: string, intent: OrgIntent): OrgGate {
  const gate = ctx.state[STATE_KEY] as OrgGate | undefined;
  if (!gate || gate.uid !== uid || gate.intent !== intent)
    throw new errors.ForbiddenError("Forbidden");
  return gate;
}

function personOf(value: unknown): OrgPersonRef | null {
  if (!isRecord(value) || typeof value.id !== "number" || typeof value.documentId !== "string")
    return null;
  return {
    id: value.id,
    documentId: value.documentId,
    displayName: text(value.displayName) || text(value.username) || "",
  };
}

/** The structure an admin edits: relations by name, and what a delete would detach. */
async function structureOf(
  strapi: CountHost,
  uid: string,
  row: AuthoringRow,
): Promise<Partial<DepartmentEditable> | Partial<TeamEditable>> {
  if (uid === DEPARTMENT_UID) {
    const where = { department: { id: row.id } };
    const [memberCount, teamCount] = await Promise.all([
      strapi.db.query(USER_UID).count({ where }),
      strapi.db.query(TEAM_UID).count({ where }),
    ]);
    return { head: personOf(row.head), memberCount, teamCount };
  }
  const department = row.department;
  const members = (Array.isArray(row.members) ? row.members : [])
    .map(personOf)
    .filter((person): person is OrgPersonRef => person !== null)
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "de"));
  return {
    department:
      isRecord(department) && typeof department.documentId === "string"
        ? { documentId: department.documentId, name: text(department.name) ?? "" }
        : null,
    lead: personOf(row.lead),
    members,
  };
}

async function editableDto(
  strapi: CountHost,
  uid: string,
  gate: OrgGate & { row: AuthoringRow },
): Promise<DepartmentEditable | TeamEditable> {
  const { row, roleClass, observedRevision } = gate;
  const field = mediaField(uid);
  return {
    documentId: row.documentId,
    version: String(observedRevision),
    updatedAt: iso(row.updatedAt),
    name: text(row.name) ?? "",
    slug: text(row.slug) ?? "",
    description: text(row.description),
    roleClass,
    ...(uid === DEPARTMENT_UID ? { color: text(row.color) } : {}),
    ...(roleClass === "moderator"
      ? { [field]: editableMediaOf(row[field]), ...(await structureOf(strapi, uid, row)) }
      : {}),
  };
}

/** Status-free org writes reuse the revision lock/audit and return only the committed identity. */
export function orgAuthoringActions(
  strapiValue: unknown,
  uid: string,
): Record<string, (ctx: unknown) => Promise<void>> {
  const strapi = strapiValue as AuthoringControllerHost;
  const existingRow = (gate: OrgGate): AuthoringRow => {
    if (!gate.row) throw new errors.ForbiddenError("Forbidden");
    return gate.row;
  };
  const scopeOf = (ctx: AuthoringContext, gate: OrgGate, missingClass: 403 | 404) =>
    ({
      uid,
      documentId: existingRow(gate).documentId,
      expectedRevision: parseIfMatch(ctx.get("If-Match")),
      observedRevision: gate.observedRevision,
      classify: gate.classify,
      roleClass: gate.roleClass,
      missingClass,
      source: "content-api",
    }) satisfies AuthoringScope;
  return {
    async editable(value) {
      const ctx = value as AuthoringContext;
      const gate = gateFor(ctx, uid, "editable");
      noQuery(ctx.query);
      ctx.set("ETag", etagOf(gate.observedRevision));
      ctx.status = 200;
      ctx.body = { data: await editableDto(strapi, uid, { ...gate, row: existingRow(gate) }) };
    },
    async create(value) {
      const ctx = value as AuthoringContext;
      await answering(ctx, async () => {
        const gate = gateFor(ctx, uid, "create");
        noQuery(ctx.query);
        const data = payloadOf(ctx);
        const scope: AuthoringScope = { uid, roleClass: gate.roleClass, source: "content-api" };
        const documentId = await strapi.db.transaction(async () =>
          runInAuthoringScope(scope, async () => {
            const created = documentIdOf(await strapi.documents(uid).create({ data }));
            if (!created) throw new Error(`org authoring: ${uid} create returned no document`);
            return created;
          }),
        );
        const version = scope.committedRevision ?? 1;
        ctx.set("ETag", etagOf(version));
        ctx.status = 201;
        ctx.body = { data: { documentId, version: String(version) } };
      });
    },
    async update(value) {
      const ctx = value as AuthoringContext;
      await answering(ctx, async () => {
        const gate = gateFor(ctx, uid, "update");
        noQuery(ctx.query);
        const data = payloadOf(ctx);
        const scope: AuthoringScope = scopeOf(ctx, gate, 403);
        await strapi.db.transaction(async () =>
          runInAuthoringScope(scope, async () => {
            await strapi.documents(uid).update({ documentId: scope.documentId, data });
          }),
        );
        const version = scope.committedRevision ?? 0;
        ctx.set("ETag", etagOf(version));
        ctx.status = 200;
        ctx.body = { data: { documentId: scope.documentId, version: String(version) } };
      });
    },
    async delete(value) {
      const ctx = value as AuthoringContext;
      await answering(ctx, async () => {
        const gate = gateFor(ctx, uid, "delete");
        noQuery(ctx.query);
        const scope: AuthoringScope = scopeOf(ctx, gate, 404);
        // The department/team delete hooks run inside this transaction (they refuse any other).
        await strapi.db.transaction(async () =>
          runInAuthoringScope(scope, () =>
            strapi.documents(uid).delete({ documentId: scope.documentId }),
          ),
        );
        ctx.status = 204;
        ctx.body = null;
      });
    },
  };
}
