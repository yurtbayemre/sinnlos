import { DEPARTMENT_AUTHOR_ROLES, MODERATORS, SCHEDULER_ROLES } from "@sinnlos/domain";
import type * as RolesModule from "@/lib/roles";
import type { AuthoringArea, AuthoringScope, AuthoringVerb, Capabilities } from "@/lib/roles";

/**
 * The capability values of batch 15 (contract K8, lane 15A; plan 15A item
 * 12 and 15C item 11), for the /manage suites while this lane's base still
 * carries batch 14's values: moderators gain publish, unpublish and discard
 * on the draft & publish areas; department_head authors announcements,
 * events and documents for its own department ({create, edit, publish,
 * unpublish, discard}, "ownDepartment"); `schedule` only for
 * SCHEDULER_ROLES; `manage` for moderators and department authors. The
 * rest is lib/roles.ts's own capabilitiesFor.
 *
 * Takes the roles module as an argument (runtime imports would loop through
 * a vi.mock of "@/lib/roles"): `vi.mock("@/lib/roles", async (original) =>
 * { const roles = await original(); return { ...roles, capabilitiesFor:
 * (role) => k8Capabilities(roles, role) }; })`.
 */
const DRAFT_AREAS: readonly AuthoringArea[] = [
  "announcements",
  "events",
  "quickLinks",
  "documents",
];
const DEPARTMENT_AREAS: readonly AuthoringArea[] = ["announcements", "events", "documents"];

const holds = (roles: readonly string[], role: unknown) =>
  typeof role === "string" && roles.includes(role);

export function k8Capabilities(
  roles: typeof RolesModule,
  role: string | null | undefined,
): Capabilities {
  const base = roles.capabilitiesFor(role);
  const moderator = holds(MODERATORS, role);
  const departmentAuthor = holds(DEPARTMENT_AUTHOR_ROLES, role);
  const scheduler = holds(SCHEDULER_ROLES, role);
  const author = {} as Record<AuthoringArea, ReadonlySet<AuthoringVerb>>;
  const authorScope = {} as Record<AuthoringArea, AuthoringScope | null>;
  for (const area of roles.AUTHORING_AREAS) {
    const verbs = new Set<AuthoringVerb>(base.author[area]);
    if (moderator && DRAFT_AREAS.includes(area)) {
      for (const verb of ["publish", "unpublish", "discard"] as const) verbs.add(verb);
    }
    if (departmentAuthor && DEPARTMENT_AREAS.includes(area)) {
      for (const verb of ["create", "edit", "publish", "unpublish", "discard"] as const) {
        verbs.add(verb);
      }
    }
    if (!scheduler) verbs.delete("schedule");
    author[area] = verbs;
    authorScope[area] =
      verbs.size === 0 ? null : moderator ? "any" : departmentAuthor ? "ownDepartment" : null;
  }
  return { ...base, manage: moderator || departmentAuthor, author, authorScope };
}
