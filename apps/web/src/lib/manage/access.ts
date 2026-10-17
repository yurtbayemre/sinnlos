/**
 * What a viewer may do in a /manage area (deep-dive decision 06 §L1, §L2,
 * §N7): read from the role-only capabilities of lib/roles.ts (SH02), never
 * from a row. UX only: the cms decides every write per request, and a
 * department author reaches items only through their own authoringList,
 * so no per-item row helper exists (§L2 "The viewer's department").
 *
 * The values per batch are lib/roles.ts's (contract K8, lane 15A); this
 * module only reads them:
 *   - `author[area]` empty: the area is hidden and its pages redirect;
 *   - `authorScope[area]` "any": the moderator class;
 *     "ownDepartment": the department-author class, which also needs the
 *     viewer's department (getViewer(), per request): without one the
 *     pages explain instead of showing a list or a form (§N1).
 * Pure; the shape is plain data, so pages hand it to client forms.
 */
import type { AuthoringRoleClass } from "@sinnlos/domain";
import type { AuthoringScope, AuthoringVerb, Capabilities } from "@/lib/roles";
import { AREA_CAPABILITY, MANAGE_AREAS, type ManageArea } from "./areas";

/** The verbs of the capability model, in the order the publish bar uses them. */
const VERB_ORDER: readonly AuthoringVerb[] = [
  "create",
  "edit",
  "publish",
  "unpublish",
  "schedule",
  "discard",
  "delete",
];

export interface AreaAccess {
  area: ManageArea;
  /** The verbs the role holds on the area (never empty). */
  verbs: readonly AuthoringVerb[];
  scope: AuthoringScope;
  /** The cms write-gate class the forms follow (@sinnlos/domain AUTHORING_FIELDS). */
  roleClass: AuthoringRoleClass;
}

/**
 * The viewer's access to `area` (its capability area, AREA_CAPABILITY: the
 * wiki reads `wikiSpaces`), or null when the role authors nothing there.
 */
export function areaAccess(capabilities: Capabilities, area: ManageArea): AreaAccess | null {
  const verbs = capabilities.author[AREA_CAPABILITY[area]];
  const scope = capabilities.authorScope[AREA_CAPABILITY[area]];
  if (!verbs || verbs.size === 0 || scope === null) return null;
  return {
    area,
    verbs: VERB_ORDER.filter((verb) => verbs.has(verb)),
    scope,
    roleClass: scope === "ownDepartment" ? "departmentAuthor" : "moderator",
  };
}

/** Whether `access` holds `verb` (false without access). */
export function canDo(access: AreaAccess | null | undefined, verb: AuthoringVerb): boolean {
  return !!access && access.verbs.includes(verb);
}

/** The /manage areas the viewer authors in, in landing order. */
export function manageAreasFor(capabilities: Capabilities): Exclude<ManageArea, "lessons">[] {
  return MANAGE_AREAS.filter((area) => areaAccess(capabilities, area) !== null);
}

/**
 * A department author without a department (§N1): the cms refuses every
 * write and lists nothing, so the page explains instead (§L2).
 */
export function lacksDepartment(
  access: AreaAccess | null | undefined,
  viewerDepartment: { documentId: string } | null | undefined,
): boolean {
  return access?.scope === "ownDepartment" && !viewerDepartment?.documentId;
}
