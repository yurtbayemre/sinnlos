/**
 * The option lists of the /manage forms (deep-dive decision 06 §L4: the
 * department and team pickers): every department and every team, by
 * documentId, with names only. Transport (WD03); lib/loaders/manage/
 * options.ts turns them into the pickers' view model. The authoring writes
 * reference departments and teams by documentId (K7), which Strapi 5 returns
 * next to every row's fields.
 *
 * Reads only the names: no head, lead or member populate, so no contact
 * field travels (data minimisation, issue #10). Walks every page with a
 * stable secondary sort, like the org reads (issue #26).
 */
import { walkAllPages, type WalkResult } from "@/lib/paginate";
import { strapi, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery } from "@/lib/strapi/query";

export interface DepartmentOptionRow {
  id: number;
  documentId: string;
  name: string;
}

export interface TeamOptionRow {
  id: number;
  documentId: string;
  name: string;
  department?: { documentId?: string; name?: string } | null;
}

/** Every department's documentId and name (at most 1000, like the org list). */
export function listDepartmentOptions(): Promise<WalkResult<DepartmentOptionRow>> {
  return walkAllPages<DepartmentOptionRow>(
    (page) =>
      strapi<StrapiListResponse<DepartmentOptionRow>>(
        withQuery(
          "/api/departments",
          strapiQuery().fields(["name"]).sort(["name:asc", "id:asc"]).page(page, 100),
        ),
      ),
    { maxPages: 10, label: "manage-departments" },
  );
}

/** Every team's documentId, name and department (at most 2000, like the org list). */
export function listTeamOptions(): Promise<WalkResult<TeamOptionRow>> {
  return walkAllPages<TeamOptionRow>(
    (page) =>
      strapi<StrapiListResponse<TeamOptionRow>>(
        withQuery(
          "/api/teams",
          strapiQuery()
            .fields(["name"])
            .populateFields("department", ["name"])
            .sort(["name:asc", "id:asc"])
            .page(page, 100),
        ),
      ),
    { maxPages: 20, label: "manage-teams" },
  );
}
