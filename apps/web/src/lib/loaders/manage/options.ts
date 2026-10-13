import { listDepartmentOptions, listTeamOptions } from "@/lib/api/manage/options";
import { SKIPPED_READ, tryFetch } from "@/lib/safe-fetch";

/**
 * The targeting pickers of the /manage forms (WD03; deep-dive decision 06
 * §L4): departments and teams by documentId and name.
 *
 * A failed read is `failed`, never "there are no departments": a form
 * whose picker could not load refuses to save a targeting change (it would
 * otherwise only offer "everyone", the poll form's rule since decision 02).
 * A department author's team picker lists only their own department's
 * teams (§L4), and they get no department list at all: their department is
 * pinned and shown from the viewer.
 */

export interface DepartmentOption {
  documentId: string;
  name: string;
}

export interface TeamOption {
  documentId: string;
  name: string;
  /** The team's department (documentId), or null. */
  department: string | null;
}

export interface TargetingOptionsView {
  departments: DepartmentOption[];
  teams: TeamOption[];
  /** A read failed: the pickers say so and the targeting cannot be changed. */
  failed: boolean;
  /** A walk stopped at its cap: some options may be missing. */
  truncated: boolean;
}

export interface TargetingOptionsRequest {
  /** Read the department list (moderators). */
  departments: boolean;
  /** Read the team list (announcements). */
  teams: boolean;
  /** Keep only this department's teams (a department author's documentId). */
  teamsOf?: string | null;
}

export async function loadTargetingOptions(
  request: TargetingOptionsRequest,
): Promise<TargetingOptionsView> {
  const [departments, teams] = await Promise.all([
    request.departments ? tryFetch(() => listDepartmentOptions(), "manage-options") : SKIPPED_READ,
    request.teams ? tryFetch(() => listTeamOptions(), "manage-options") : SKIPPED_READ,
  ]);
  const teamRows = (teams.data?.data ?? []).map((team) => ({
    documentId: team.documentId,
    name: team.name,
    department: team.department?.documentId ?? null,
  }));
  return {
    departments: (departments.data?.data ?? []).map((department) => ({
      documentId: department.documentId,
      name: department.name,
    })),
    teams: request.teamsOf
      ? teamRows.filter((team) => team.department === request.teamsOf)
      : teamRows,
    failed: departments.failed || teams.failed,
    truncated: (departments.data?.truncated ?? false) || (teams.data?.truncated ?? false),
  };
}
