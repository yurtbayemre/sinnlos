import type { WikiEditorClass } from "./authoring/wiki.js";
import { DEPARTMENT_AUTHOR_ROLES, MODERATORS, type RoleType } from "./roles.js";

/**
 * Who edits a wiki page (deep-dive decision 06 §A "Row", §J2, §N1; batch 16
 * plan, lane 16B, contract K17): the ONE rule the cms row gate
 * (apps/cms/src/policies/can-edit-wiki.ts) and the web's "Edit" buttons
 * decide by, so a button never shows where the cms refuses, nor the other
 * way round.
 *
 *   - `moderator`: admin_role and editor, on every page;
 *   - `author`: the page's author, when their role holds the wiki-page
 *     update grant (department_head, team_lead, member);
 *   - `departmentHead`: a department head (DEPARTMENT_AUTHOR_ROLES) whose
 *     `user.department` is the page's department (the department-author
 *     loader of §N1: role plus department, read per request);
 *   - `teamLead`: a team lead who leads the page's team;
 *   - null: no class (guest, `authenticated`, anyone else).
 *
 * The first match wins, in that order. Ids are users-permissions user ids
 * and department row ids (single rows since decision 05), compared exactly;
 * a missing id never matches.
 *
 * What this does NOT decide (the cms adds it): that every row of the page
 * (its draft and its published twin) gives the caller a class, and that a
 * non-moderator can read the space the page sits in. The web shows the
 * button from the published page it renders; the cms answers 404 or 403
 * where its stricter view differs (a moderator moved the draft).
 */

/** The roles that hold the wiki-page update grant besides the moderators (the row classes). */
export const WIKI_ROW_EDITOR_ROLES: readonly RoleType[] = [
  "department_head",
  "team_lead",
  "member",
];

/** The roles that hold the wiki-page create grant: moderators, department heads, team leads. */
export const WIKI_PAGE_CREATOR_ROLES: readonly RoleType[] = [
  ...MODERATORS,
  "department_head",
  "team_lead",
];

/** The caller as the rule reads it. */
export interface WikiEditViewer {
  /** The role type (`role.type`). */
  role: string | null | undefined;
  /** The users-permissions user id. */
  userId: number | null | undefined;
  /** The id of the caller's `user.department`. */
  departmentId: number | null | undefined;
}

/** One row of the page as the rule reads it. */
export interface WikiEditPage {
  /** The id of the page's `author`. */
  authorId: number | null | undefined;
  /** The id of the page's `department`. */
  departmentId: number | null | undefined;
  /** The id of the `lead` of the page's `team`. */
  teamLeadId: number | null | undefined;
}

const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const holds = (role: unknown, roles: readonly RoleType[]): boolean =>
  typeof role === "string" && (roles as readonly string[]).includes(role);

/** The class `viewer` edits `page` as, or null (see the module comment). */
export function classifyWikiEditor(
  viewer: WikiEditViewer,
  page: WikiEditPage,
): WikiEditorClass | null {
  if (holds(viewer.role, MODERATORS)) return "moderator";
  if (!holds(viewer.role, WIKI_ROW_EDITOR_ROLES) || !isId(viewer.userId)) return null;
  if (isId(page.authorId) && page.authorId === viewer.userId) return "author";
  if (
    holds(viewer.role, DEPARTMENT_AUTHOR_ROLES) &&
    isId(viewer.departmentId) &&
    page.departmentId === viewer.departmentId
  ) {
    return "departmentHead";
  }
  if (viewer.role === "team_lead" && isId(page.teamLeadId) && page.teamLeadId === viewer.userId) {
    return "teamLead";
  }
  return null;
}

/** Whether `role` may create wiki pages (the create grant; the space must be readable too). */
export function canCreateWikiPages(role: string | null | undefined): boolean {
  return holds(role, WIKI_PAGE_CREATOR_ROLES);
}
