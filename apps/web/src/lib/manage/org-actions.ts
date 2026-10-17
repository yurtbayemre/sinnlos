"use server";

import { refresh } from "next/cache";
import type { OrgAuthoringType, OrgWriteResponse } from "@sinnlos/domain";
import { actionFailure, runCmsAction, type ActionResult } from "@/lib/action-result";
import { sendOrgUpdate } from "@/lib/api/manage/org";
import { getViewer } from "@/lib/viewer";
import { validReference } from "./authoring-action";
import { orgEditScope } from "./org-access";
import { buildOrgPayload, coerceOrgValues } from "./org-values";

export interface OrgSaveInput {
  documentId: unknown;
  version: unknown;
  values: unknown;
  initial: unknown;
}
export type OrgActionResult = ActionResult<never, OrgWriteResponse["data"] | null>;

/** Current role first; the CMS checks the row, exact fields and If-Match under its lock. */
export async function saveOrg(type: OrgAuthoringType, raw: OrgSaveInput): Promise<OrgActionResult> {
  const viewer = await getViewer();
  if (viewer.id === null) return actionFailure("unavailable");
  if ((type !== "department" && type !== "team") || orgEditScope(type, viewer.role) === "none")
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
