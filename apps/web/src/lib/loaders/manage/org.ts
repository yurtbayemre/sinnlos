import { unstable_rethrow } from "next/navigation";
import type { OrgAuthoringType } from "@sinnlos/domain";
import { departmentBySlug, teamBySlug } from "@/lib/api/org";
import { fetchOrgEditable, type OrgEditable } from "@/lib/api/manage/org";
import { orgEditScope } from "@/lib/manage/org-access";
import { kudosRecipientQuery, toKudosRecipients } from "@/lib/people-dto";
import { tryFetch } from "@/lib/safe-fetch";
import type { UserLite } from "@/lib/types";
import { fetchAllUsers } from "@/lib/users";
import type { Viewer } from "@/lib/viewer";
import { editableLoad, isNotFoundError, type EditorLoad } from "./editor";
import { loadTargetingOptions, type DepartmentOption } from "./options";

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

/** A person the head, lead and member pickers offer: the directory without blocked accounts. */
export interface OrgPersonOption {
  id: number;
  label: string;
}

export interface OrgOptionsView {
  people: OrgPersonOption[];
  /** Every department (a team's department picker). */
  departments: DepartmentOption[];
  /** A read failed: the structure fields say so and stay as they are. */
  failed: boolean;
}

/** The pickers of admin_role's structure fields (v0.22); the same directory read as the kudos picker. */
export async function loadOrgOptions(type: OrgAuthoringType): Promise<OrgOptionsView> {
  const [people, targeting] = await Promise.all([
    tryFetch(() => fetchAllUsers<UserLite>(kudosRecipientQuery(null)), "manage-org-people"),
    loadTargetingOptions({ departments: type === "team", teams: false }),
  ]);
  return {
    people: toKudosRecipients(people.data?.users ?? [], null).map(
      ({ id, displayName, jobTitle }) => ({
        id,
        label: jobTitle ? `${displayName} (${jobTitle})` : displayName,
      }),
    ),
    departments: targeting.departments,
    failed: people.failed || (type === "team" && targeting.failed),
  };
}
