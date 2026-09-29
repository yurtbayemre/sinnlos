/**
 * Departments and teams (WD01). Every read is uncached (D-DC01, see
 * lib/strapi/client.ts); the field-limited user populates are data
 * minimisation — a consumer gets only the columns it renders.
 */
import type { TeamMembership } from "@/lib/audience";
import { walkAllPages, type WalkResult } from "@/lib/paginate";
import { strapi, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery } from "@/lib/strapi/query";
import type { Department, Team, UserLite } from "@/lib/types";

/** A user as the list populates deliver it: display name and job title, no contact field. */
export type UserName = Pick<UserLite, "id" | "displayName" | "jobTitle">;

/** A department as a plain `populate[...]=true` delivers it: own fields, no relations. */
export type DepartmentRow = Omit<Department, "head" | "members" | "teams">;

/** A team as a plain `populate[...]=true` delivers it: own fields, no relations. */
export type TeamRow = Omit<Team, "department" | "lead" | "members">;

/** A department of the list: `head` field-limited, teams without their relations. */
export type DepartmentListItem = DepartmentRow & {
  head?: UserName | null;
  teams?: TeamRow[];
};

/** A team of the list: the department row, lead and members field-limited. */
export type TeamListItem = TeamRow & {
  department?: DepartmentRow | null;
  lead?: UserName | null;
  members?: UserName[];
};

/**
 * The department list (and the dashboard/search consumers) only ever
 * renders the department's own fields + team/member COUNTS — never a
 * head/member contact field. The `head` user relation is field-limited to
 * non-sensitive columns so NO sensitive field (email/phone/hireDate/
 * officeLocation/microsoftOid) is in the payload: data minimisation, the
 * list never needs them (issue #10 / F1). No headerImage (WD05): no page
 * renders it, here or on the detail page.
 *
 * Walks every page: without an explicit pageSize Strapi serves only
 * `api.rest.defaultLimit` = 25 rows, so department #26 silently vanished
 * from the index, the dashboard count and the search preload (issue #26).
 * Secondary sort on id keeps the walk stable — `name` is not unique.
 * Hard cap: 10 pages x 100 = 1000 departments.
 */
export function listDepartments(): Promise<WalkResult<DepartmentListItem>> {
  return walkAllPages<DepartmentListItem>(
    (page) =>
      strapi<StrapiListResponse<DepartmentListItem>>(
        withQuery(
          "/api/departments",
          strapiQuery()
            .populateFields("head", ["displayName", "jobTitle"])
            .populate("teams")
            .sort(["name:asc", "id:asc"])
            .page(page, 100),
        ),
      ),
    { maxPages: 10, label: "departments" },
  );
}

/**
 * Per-user response: the detail page shows the head's and each member's
 * email as the internal contact line (`jobTitle ?? email`), and the CMS
 * content-api sanitizer strips email for non-privileged callers — a guest
 * and a member get different payloads for the same URL (issue #10 / F1,
 * same as people/wiki).
 *
 * No page walk needed here: `slug` is a uid attribute (unique), so the
 * top-level result is 0..1 rows — the defaultLimit of 25 only bounds
 * top-level pagination, and Strapi 5 REST does not paginate populated
 * relations (teams/members arrive in full).
 */
export function departmentBySlug(slug: string): Promise<StrapiListResponse<Department>> {
  return strapi<StrapiListResponse<Department>>(
    withQuery(
      "/api/departments",
      strapiQuery()
        .filter("slug", "$eq", slug)
        .populate("head")
        .populate(["teams", "lead"])
        .populate("members"),
    ),
  );
}

/**
 * Field-limited like listDepartments: the list/dashboard/search consumers
 * use only team fields + member COUNT, never a lead/member contact field,
 * so the `lead`/`members` user relations are limited to non-sensitive
 * columns (data minimisation, issue #10 / F1).
 *
 * Walks every page (issue #26): the old single request sent no pageSize
 * and stopped at Strapi's defaultLimit of 25, so team #26 was missing from
 * the index, the dashboard count and the search preload. Secondary sort on
 * id keeps the walk stable — `name` is not unique. Hard cap: 20 pages x
 * 100 = 2000 teams (parity with lib/teams.ts MAX_PAGES).
 */
export function listTeams(): Promise<WalkResult<TeamListItem>> {
  return walkAllPages<TeamListItem>(
    (page) =>
      strapi<StrapiListResponse<TeamListItem>>(
        withQuery(
          "/api/teams",
          strapiQuery()
            .populate("department")
            .populateFields("lead", ["displayName", "jobTitle"])
            .populateFields("members", ["displayName", "jobTitle"])
            .sort(["name:asc", "id:asc"])
            .page(page, 100),
        ),
      ),
    { maxPages: 20, label: "teams" },
  );
}

/**
 * Per-user response: the detail page renders the lead's and members'
 * email as the internal contact line (`jobTitle ?? email`), which the
 * sanitizer strips for non-privileged callers (issue #10 / F1, same as
 * departmentBySlug).
 *
 * No page walk needed: `slug` is a uid attribute (unique) → 0..1 top-level
 * rows; populated relations are not paginated by Strapi 5 REST. No
 * populate[pages]: the page never rendered it, and the CMS strips it for
 * non-admin/editor callers anyway (global relation guard, FX05).
 */
export function teamBySlug(slug: string): Promise<StrapiListResponse<Team>> {
  return strapi<StrapiListResponse<Team>>(
    withQuery(
      "/api/teams",
      strapiQuery()
        .filter("slug", "$eq", slug)
        .populate("department")
        .populate("lead")
        .populate("members"),
    ),
  );
}

/**
 * One page of the team roster for the acknowledgement report (lib/teams.ts
 * walks it): only the lead's and members' ids (`id` is returned whatever
 * `fields` says; username is the smallest non-sensitive column), sorted by
 * id so the walk is stable (Postgres returns rows in an undefined order
 * without ORDER BY).
 */
export function teamRosterPage(
  page: number,
  pageSize: number,
): Promise<StrapiListResponse<TeamMembership>> {
  return strapi<StrapiListResponse<TeamMembership>>(
    withQuery(
      "/api/teams",
      strapiQuery()
        .populateFields("lead", ["username"])
        .populateFields("members", ["username"])
        .sortBy("id:asc")
        .page(page, pageSize),
    ),
  );
}
