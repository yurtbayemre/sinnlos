import { unstable_rethrow } from "next/navigation";
import type { OrgAuthoringType } from "@sinnlos/domain";
import { departmentBySlug, teamBySlug } from "@/lib/api/org";
import { fetchOrgEditable, type OrgEditable } from "@/lib/api/manage/org";
import { orgEditScope } from "@/lib/manage/org-access";
import type { Viewer } from "@/lib/viewer";
import { editableLoad, isNotFoundError, type EditorLoad } from "./editor";

/** Resolve the reader slug, then get all form values and rights from the fixed editable DTO. */
export async function loadOrgEditable(
  type: OrgAuthoringType,
  slug: string,
  viewer: Viewer,
): Promise<EditorLoad<OrgEditable>> {
  if (viewer.id === null) return { state: "failed" };
  if (orgEditScope(type, viewer.role) === "none") return { state: "notFound" };
  try {
    const result = await (type === "department" ? departmentBySlug(slug) : teamBySlug(slug));
    const row = result.data?.[0];
    if (!row?.documentId) return { state: "notFound" };
    return editableLoad(`manage-${type}`, row.documentId, () =>
      fetchOrgEditable(type, row.documentId!),
    );
  } catch (error) {
    unstable_rethrow(error);
    if (isNotFoundError(error)) return { state: "notFound" };
    console.error(`[manage-${type}] resolve failed`, error);
    return { state: "failed" };
  }
}
