import type { OrgAuthoringType } from "@sinnlos/domain";
import { capabilitiesFor } from "@/lib/roles";
import type { Department, Team } from "@/lib/types";
import type { Viewer } from "@/lib/viewer";

export function orgEditScope(type: OrgAuthoringType, role: Viewer["role"]) {
  const org = capabilitiesFor(role).org;
  return type === "department" ? org.editDepartment : org.editTeam;
}

/** Presentation only; editable/update enforce the current row class in the CMS. */
export function canEditOrg(
  type: OrgAuthoringType,
  row: Department | Team,
  viewer: Viewer,
): boolean {
  const scope = orgEditScope(type, viewer.role);
  if (!viewer.id || !row.documentId || scope === "none") return false;
  if (scope === "any") return true;
  if (type === "team" && (row as Team).lead?.id === viewer.id) return true;
  return (
    viewer.role === "department_head" &&
    viewer.department !== null &&
    viewer.department.id === (type === "department" ? row.id : (row as Team).department?.id)
  );
}
