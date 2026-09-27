import type { PollResults } from "@/lib/types";

/**
 * What the poll card shows about department targeting (decision 02). The
 * CMS decides everything per caller in GET /api/polls/:id/results; the web
 * only renders it and never re-derives eligibility from the role.
 *
 * - `canVote`: false only when the CMS says so (an admin or editor outside
 *   the poll's departments). A CMS older than decision 02 sends no field,
 *   so a missing value keeps the vote buttons, as before.
 * - `departmentNames`: the targeted departments for the "Only for" badge.
 * - `hint`: "audienceMissing" when a targeted poll has no department left
 *   (only admins and editors ever see one: nobody can vote until its
 *   departments are selected again), otherwise "notInAudience" when the
 *   caller cannot vote.
 */
export type PollAudienceHint = "audienceMissing" | "notInAudience";

export interface PollAudienceView {
  canVote: boolean;
  targeted: boolean;
  departmentNames: string[];
  hint: PollAudienceHint | null;
}

export function pollAudienceView(results: Pick<PollResults, "canVote" | "audience">): PollAudienceView {
  const canVote = results.canVote !== false;
  const targeted = results.audience?.targeted === true;
  const departments = results.audience?.departments ?? [];
  const departmentNames = departments
    .map((department) => department.name)
    .filter((name) => typeof name === "string" && name.length > 0);
  let hint: PollAudienceHint | null = null;
  if (targeted && departments.length === 0) hint = "audienceMissing";
  else if (!canVote) hint = "notInAudience";
  return { canVote, targeted, departmentNames, hint };
}
