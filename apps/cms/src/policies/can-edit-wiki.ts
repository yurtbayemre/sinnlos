import { loadUserScope, visibleWikiSpaceIds } from "../utils/visible-ids";
import { editablePageSpace, wikiRelationChecks } from "../utils/wiki-write-targets";
import {
  USER_UID,
  WIKI_PAGE_UID,
  enforceWriteAllowlist,
  isWriteBypassRole,
  targetRowWhere,
  type StrapiDb,
  type WritePolicy,
} from "../utils/write-allowlist";

interface PageRow {
  id: number;
  documentId: string;
  author?: { id?: number } | null;
  department?: { id?: number } | null;
  team?: { id?: number; lead?: { id?: number } | null } | null;
}

interface CallerRow {
  department?: { id?: number } | null;
}

type PageEditorClass = "author" | "departmentHead" | "teamLead";

/**
 * Write gate for wiki pages, create and update (#24, FX07).
 *
 * admin_role / editor pass with the payload untouched: they also author in
 * the admin panel and may place pages anywhere.
 *
 * Create (no target id): any role but guest (the create grant itself is
 * held by department_head and team_lead only). Role class "author": page
 * content, a required `space` the caller can read and an optional `parent`
 * that is a readable page of that space. author and lastEditor are set to
 * the caller.
 *
 * Update: the page's author, the head of the page's department or the lead
 * of the page's team (classes "author", "departmentHead", "teamLead", first
 * match wins), and, new with FX07, only while every row of the page sits in
 * one space the caller can read. Page content, `revisionSummary` (the
 * controller consumes it) and a `parent` that is a readable page of the
 * SAME space, neither the page itself nor one of its descendants. The
 * controller still sets lastEditor.
 *
 * Everything else a non-bypass payload carries answers the allowlist's
 * generic 400: `space` on update, `children`, `revisions`, `author`,
 * `lastEditor`, `department`, `team`, Strapi's own keys. The fields and
 * checks live in utils/write-allowlist.ts and utils/wiki-write-targets.ts.
 * The allowlist also pins `status=published` for these callers, so a
 * `?status=draft` write cannot answer with draft rows through
 * `populate[space][populate][pages]`, `parent` or `children`.
 *
 * A row the caller may not write is `false` (403), the same for a missing
 * page, a page they do not own and a page in a space they cannot read; the
 * payload is only looked at after that. Strict boolean result: Strapi
 * treats `undefined` as a pass.
 */
export default async (
  policyContext: WritePolicy,
  _config: unknown,
  { strapi }: { strapi: StrapiDb },
): Promise<boolean> => {
  const user = policyContext.state?.user;
  const roleType = user?.role?.type;
  if (!user || typeof user.id !== "number" || !roleType) return false;
  if (isWriteBypassRole(roleType)) return true;
  if (roleType === "guest") return false;

  const where = targetRowWhere(policyContext.params?.id);
  if (!where) {
    const visibleSpaceIds = await visibleSpacesOf(strapi, user.id);
    return enforceWriteAllowlist(
      policyContext,
      { uid: WIKI_PAGE_UID, action: "create", roleClass: "author" },
      { callerId: user.id, relationChecks: wikiRelationChecks(strapi, { visibleSpaceIds }) },
    );
  }

  const page = (await strapi.db.query(WIKI_PAGE_UID).findOne({
    where,
    populate: { author: true, department: true, team: { populate: { lead: true } } },
  })) as PageRow | null;
  if (!page) return false;
  const roleClass = await pageEditorClass(strapi, user.id, roleType, page);
  if (!roleClass) return false;

  const visibleSpaceIds = await visibleSpacesOf(strapi, user.id);
  const spaceDocumentId = await editablePageSpace(strapi, page.documentId, visibleSpaceIds);
  if (!spaceDocumentId) return false;

  return enforceWriteAllowlist(
    policyContext,
    { uid: WIKI_PAGE_UID, action: "update", roleClass },
    {
      callerId: user.id,
      relationChecks: wikiRelationChecks(strapi, {
        visibleSpaceIds,
        spaceDocumentId,
        pageDocumentId: page.documentId,
      }),
    },
  );
};

async function visibleSpacesOf(strapi: StrapiDb, userId: number): Promise<Set<number>> {
  return new Set(await visibleWikiSpaceIds(strapi, await loadUserScope(strapi, userId)));
}

async function pageEditorClass(
  strapi: StrapiDb,
  userId: number,
  roleType: string,
  page: PageRow,
): Promise<PageEditorClass | undefined> {
  if (page.author?.id === userId) return "author";
  if (roleType === "department_head" && typeof page.department?.id === "number") {
    const me = (await strapi.db.query(USER_UID).findOne({
      where: { id: userId },
      populate: { department: true },
    })) as CallerRow | null;
    if (me?.department?.id === page.department.id) return "departmentHead";
  }
  if (roleType === "team_lead" && page.team?.lead?.id === userId) return "teamLead";
  return undefined;
}
