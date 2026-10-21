"use server";

import { refresh } from "next/cache";
import type { OrgAuthoringType, OrgWriteResponse } from "@sinnlos/domain";
import { actionFailure, runCmsAction, type ActionResult } from "@/lib/action-result";
import { sendOrgCreate, sendOrgDelete, sendOrgUpdate } from "@/lib/api/manage/org";
import { capabilitiesFor } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";
import { validReference } from "./authoring-action";
import { orgEditScope } from "./org-access";
import { buildOrgPayload, coerceOrgValues, emptyOrgValues } from "./org-values";

export interface OrgSaveInput {
  documentId: unknown;
  version: unknown;
  values: unknown;
  initial: unknown;
}
export type OrgActionResult = ActionResult<never, OrgWriteResponse["data"] | null>;

const isOrgType = (type: unknown): type is OrgAuthoringType =>
  type === "department" || type === "team";

/** Current role first; the CMS checks the row, exact fields and If-Match under its lock. */
export async function saveOrg(type: OrgAuthoringType, raw: OrgSaveInput): Promise<OrgActionResult> {
  const viewer = await getViewer();
  if (viewer.id === null) return actionFailure("unavailable");
  if (!isOrgType(type) || orgEditScope(type, viewer.role) === "none")
    return actionFailure("forbidden");
  if (!raw || typeof raw !== "object" || !validReference(raw.documentId, raw.version))
    return actionFailure("invalid");
  const values = coerceOrgValues(raw.values);
  const initial = coerceOrgValues(raw.initial);
  if (!values || !initial) return actionFailure("invalid");
  const roleClass =
    viewer.role === "admin_role"
      ? "moderator"
      : viewer.role === "department_head"
        ? "departmentHead"
        : "teamLead";
  const payload = buildOrgPayload(type, roleClass, values, initial);
  if (!payload.ok) return actionFailure("invalid", { fields: payload.fields });
  return runCmsAction(
    () => sendOrgUpdate(type, raw.documentId as string, raw.version as string, payload.data),
    {
      label: `[manage-${type}] save`,
      after: () => refresh(),
      data: (response) => response.data,
    },
  );
}

/** admin_role only (v0.22); the CMS's org gate decides again. */
export async function createOrg(
  type: OrgAuthoringType,
  rawValues: unknown,
): Promise<OrgActionResult> {
  const viewer = await getViewer();
  if (viewer.id === null) return actionFailure("unavailable");
  if (!isOrgType(type) || !capabilitiesFor(viewer.role).org.manage)
    return actionFailure("forbidden");
  const values = coerceOrgValues(rawValues);
  if (!values) return actionFailure("invalid");
  const payload = buildOrgPayload(type, "moderator", values, emptyOrgValues(type), "create");
  if (!payload.ok) return actionFailure("invalid", { fields: payload.fields });
  return runCmsAction(() => sendOrgCreate(type, payload.data), {
    label: `[manage-${type}] create`,
    data: (response) => response.data,
  });
}

/** admin_role only (v0.22): If-Match delete; the department/team hooks run in the CMS. */
export async function deleteOrg(
  type: OrgAuthoringType,
  documentId: unknown,
  version: unknown,
): Promise<OrgActionResult> {
  const viewer = await getViewer();
  if (viewer.id === null) return actionFailure("unavailable");
  if (!isOrgType(type) || !capabilitiesFor(viewer.role).org.manage)
    return actionFailure("forbidden");
  if (!validReference(documentId, version)) return actionFailure("invalid");
  return runCmsAction(() => sendOrgDelete(type, documentId as string, version as string), {
    label: `[manage-${type}] delete`,
    data: () => null,
  });
}
