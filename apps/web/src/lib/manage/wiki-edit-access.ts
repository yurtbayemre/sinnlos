/**
 * Whether a reader sees "Edit" and "History" on a wiki page (deep-dive
 * decision 06 §L2 "Row gates in the web", §J2; batch 16 plan, lane 16C
 * item 7; contract K17). UX only: the cms decides every edit and every
 * history read per request, and the editor's `editable` answers 404 where
 * it disagrees. Pure.
 *
 *   - the role must edit wiki pages at all (`capabilities.wikiPages.edit`:
 *     "any" for moderators, "row" for department heads, team leads and
 *     members, "none" otherwise);
 *   - then the ONE row rule the cms gate uses, @sinnlos/domain
 *     classifyWikiEditor: moderators every page; the page's author; the
 *     head of its department; the lead of its team;
 *   - FALLBACK: when the page read could not deliver an id the rule needs
 *     for this role (the cms drops a populate the role may not read, the
 *     FX05 restricted-relation guard and the users-permissions sanitizer:
 *     the key is then missing, not null), the button shows on the role's
 *     capability alone and `editable` decides. A null relation is known
 *     ("no team") and never falls back.
 */
import { classifyWikiEditor, DEPARTMENT_AUTHOR_ROLES } from "@sinnlos/domain";
import type { WikiPageDetail } from "@/lib/api/wiki";
import type { Capabilities } from "@/lib/roles";

export interface WikiEditViewerInput {
  id: number | null;
  role: string | null;
  department: { id: number } | null;
}

type PageIds = Pick<WikiPageDetail, "author" | "department" | "team">;

/** The relations the rule needs for `role` that the read did not deliver. */
function unknownForRole(role: string | null, page: PageIds): boolean {
  if (page.author === undefined) return true;
  if ((DEPARTMENT_AUTHOR_ROLES as readonly string[]).includes(role ?? "")) {
    if (page.department === undefined) return true;
  }
  if (role === "team_lead") {
    if (page.team === undefined) return true;
    if (page.team !== null && page.team.lead === undefined) return true;
  }
  return false;
}

export function canEditWikiPage(
  viewer: WikiEditViewerInput,
  capabilities: Pick<Capabilities, "wikiPages">,
  page: PageIds,
): boolean {
  if (capabilities.wikiPages.edit === "none") return false;
  const editorClass = classifyWikiEditor(
    { role: viewer.role, userId: viewer.id, departmentId: viewer.department?.id ?? null },
    {
      authorId: page.author?.id ?? null,
      departmentId: page.department?.id ?? null,
      teamLeadId: page.team?.lead?.id ?? null,
    },
  );
  if (editorClass !== null) return true;
  return unknownForRole(viewer.role, page);
}
