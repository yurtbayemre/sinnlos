import {
  IF_MATCH_HEADER,
  ORG_PATHS,
  ifMatch,
  type DepartmentEditable,
  type OrgAuthoringType,
  type OrgEditableResponse,
  type OrgWriteResponse,
  type TeamEditable,
} from "@sinnlos/domain";
import { strapi } from "@/lib/strapi/client";

export type OrgEditable = DepartmentEditable | TeamEditable;

/** Single-row endpoints deliberately have no status or other query parameters. */
export function fetchOrgEditable(
  type: OrgAuthoringType,
  documentId: string,
): Promise<OrgEditableResponse<OrgEditable>> {
  return strapi(`/api/${ORG_PATHS[type]}/${encodeURIComponent(documentId)}/editable`);
}

export function sendOrgUpdate(
  type: OrgAuthoringType,
  documentId: string,
  version: string,
  data: Record<string, unknown>,
): Promise<OrgWriteResponse> {
  return strapi(`/api/${ORG_PATHS[type]}/${encodeURIComponent(documentId)}`, {
    method: "PUT",
    headers: { [IF_MATCH_HEADER]: ifMatch(version) },
    body: JSON.stringify({ data }),
  });
}
