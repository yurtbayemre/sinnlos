import type { DepartmentEditable, OrgEditorClass, TeamEditable } from "@sinnlos/domain";
import { errors } from "@strapi/utils";

import { hasRole } from "../bootstrap/roles";
import { authoringChecks, type CallerDepartment } from "./authoring-checks";
import {
  answering,
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
import { enforceWriteAllowlist } from "./write-allowlist";
import {
  loadCallerDepartment,
  normaliseRow,
  type AuthoringRow,
  type WriteGateContext,
  type WriteGateHost,
} from "./write-gate";

const STATE_KEY = "orgAuthoring";
type OrgIntent = "update" | "editable";
interface OrgGate {
  uid: string;
  intent: OrgIntent;
  row: AuthoringRow;
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
      ...(uid === TEAM_UID ? { lead: { select: ["id"] }, department: { select: ["id"] } } : {}),
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

/** Shared by editable and update; every admitted class passes the same field allowlist. */
export function orgGate(uid: string) {
  return async (
    ctx: WriteGateContext,
    config: { intent?: unknown } | undefined,
    { strapi }: { strapi: WriteGateHost },
  ): Promise<boolean> => {
    const intent = config?.intent ?? "update";
    const refuse = (): false => {
      if (intent === "editable") throw new errors.NotFoundError("Not Found");
      return false;
    };
    const caller = identifiedCaller(ctx.state?.user);
    if (
      (uid !== DEPARTMENT_UID && uid !== TEAM_UID) ||
      (intent !== "editable" && intent !== "update") ||
      !caller ||
      !hasRole(
        caller,
        uid === DEPARTMENT_UID
          ? ["admin_role", "department_head"]
          : ["admin_role", "department_head", "team_lead"],
      )
    )
      return refuse();
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

function editableDto(uid: string, gate: OrgGate): DepartmentEditable | TeamEditable {
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
    ...(roleClass === "moderator" ? { [field]: editableMediaOf(row[field]) } : {}),
  };
}

/** Status-free org saves reuse the revision lock/audit and return only the committed identity. */
export function orgAuthoringActions(
  strapiValue: unknown,
  uid: string,
): Record<string, (ctx: unknown) => Promise<void>> {
  const strapi = strapiValue as AuthoringControllerHost;
  return {
    async editable(value) {
      const ctx = value as AuthoringContext;
      const gate = gateFor(ctx, uid, "editable");
      noQuery(ctx.query);
      ctx.set("ETag", etagOf(gate.observedRevision));
      ctx.status = 200;
      ctx.body = { data: editableDto(uid, gate) };
    },
    async update(value) {
      const ctx = value as AuthoringContext;
      await answering(ctx, async () => {
        const gate = gateFor(ctx, uid, "update");
        noQuery(ctx.query);
        const data = payloadOf(ctx);
        const scope: AuthoringScope = {
          uid,
          documentId: gate.row.documentId,
          expectedRevision: parseIfMatch(ctx.get("If-Match")),
          observedRevision: gate.observedRevision,
          classify: gate.classify,
          roleClass: gate.roleClass,
          missingClass: 403,
          source: "content-api",
        };
        await strapi.db.transaction(async () =>
          runInAuthoringScope(scope, async () => {
            await strapi.documents(uid).update({ documentId: gate.row.documentId, data });
          }),
        );
        const version = scope.committedRevision ?? 0;
        ctx.set("ETag", etagOf(version));
        ctx.status = 200;
        ctx.body = { data: { documentId: gate.row.documentId, version: String(version) } };
      });
    },
  };
}
