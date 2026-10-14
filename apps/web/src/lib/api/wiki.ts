/**
 * Wiki spaces and pages (WD01). All wiki responses are per-user: the
 * wiki-visibility policy filters results per caller, so the same URL yields
 * different pages for different users. Strapi is on the internal Docker
 * network so the round-trip cost is low. Uncached (D-DC01).
 */
import type { DepartmentRow, TeamRow } from "@/lib/api/org";
import { walkAllPages, type WalkResult } from "@/lib/paginate";
import { strapi, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery } from "@/lib/strapi/query";
import type { UserLite, WikiPage, WikiSpace } from "@/lib/types";

/** A space of the index: its own fields, department and team rows. */
export type WikiSpaceListItem = Omit<WikiSpace, "pages"> & {
  department?: DepartmentRow | null;
  team?: TeamRow | null;
};

/** A space page's table of contents: title, slug, summary and position per page. */
export type WikiSpaceDetail = Omit<WikiSpace, "pages"> & {
  pages?: Pick<WikiPage, "id" | "documentId" | "title" | "slug" | "summary" | "order">[];
};

/** A byline user: display name and username only. */
export type WikiByline = Pick<UserLite, "id" | "displayName" | "username">;

/** A page with its byline and space name (no revisions). */
export type WikiPageDetail = Omit<WikiPage, "author" | "lastEditor" | "space"> & {
  author?: WikiByline | null;
  lastEditor?: WikiByline | null;
  space?: Pick<WikiSpace, "id" | "name" | "slug"> | null;
  /**
   * The ids the Edit button's row rule reads (@sinnlos/domain
   * classifyWikiEditor, K17): the page's department and its team's lead.
   * Missing (not null) when the caller's role cannot read the relation
   * (the cms drops a populate it may not see): the button then falls back
   * to the role's capability and the editor's `editable` decides.
   */
  department?: { id: number; name?: string } | null;
  team?: { id: number; name?: string; lead?: { id: number } | null } | null;
};

/** A published page of a space as the parent picker lists it. */
export interface WikiParentRow {
  id: number;
  documentId: string;
  title: string;
  slug: string;
  order?: number | null;
  /** Missing when the populate was dropped; null at the top level. */
  parent?: { documentId: string } | null;
}

/**
 * Walks every page (issue #26): without a pageSize the wiki index stopped
 * at Strapi's defaultLimit of 25 and whole knowledge-base sections fell out
 * of the index and the search preload. Secondary sort on id keeps the walk
 * stable. Hard cap: 10 pages x 100 = 1000 spaces.
 */
export function listWikiSpaces(): Promise<WalkResult<WikiSpaceListItem>> {
  return walkAllPages<WikiSpaceListItem>(
    (page) =>
      strapi<StrapiListResponse<WikiSpaceListItem>>(
        withQuery(
          "/api/wiki-spaces",
          strapiQuery()
            .populate("department")
            .populate("team")
            .sort(["name:asc", "id:asc"])
            .page(page, 100),
        ),
      ),
    { maxPages: 10, label: "wiki spaces" },
  );
}

/**
 * No page walk for the space and page reads: `slug` is a uid attribute
 * (unique) → 0..1 top-level rows; the defaultLimit of 25 bounds only
 * top-level pagination, and Strapi 5 REST does not paginate populated
 * relations (the space's pages arrive in full).
 *
 * Field-limited (FX24, WD05): the space page lists each page's title, slug
 * and summary only, so neither the page bodies nor an author are loaded
 * (Strapi always adds id and documentId), plus its `order`, by which the
 * page sorts the list (DA02; lib/wiki-content.ts sortWikiPages: the REST
 * populate has no sort of its own here). The space's own fields include
 * its `icon`.
 */
export function wikiSpaceBySlug(slug: string): Promise<StrapiListResponse<WikiSpaceDetail>> {
  return strapi<StrapiListResponse<WikiSpaceDetail>>(
    withQuery(
      "/api/wiki-spaces",
      strapiQuery()
        .filter("slug", "$eq", slug)
        .populateFields("pages", ["title", "slug", "summary", "order"]),
    ),
  );
}

/**
 * No revisions (FX24): every view used to transfer the full body of every
 * historical revision, and none was rendered. The byline needs the author's
 * and last editor's names only; `id` tells them apart. The page's own
 * fields (not limited) carry `tocEnabled` and `tags` (DA02). The page's
 * department and its team's lead are read for the Edit button's row rule
 * (batch 16, K17): names only, the ids are what the rule compares.
 */
export function wikiPageBySlug(
  spaceSlug: string,
  pageSlug: string,
): Promise<StrapiListResponse<WikiPageDetail>> {
  return strapi<StrapiListResponse<WikiPageDetail>>(
    withQuery(
      "/api/wiki-pages",
      strapiQuery()
        .filter(["space", "slug"], "$eq", spaceSlug)
        .filter("slug", "$eq", pageSlug)
        .populateFields("author", ["displayName", "username"])
        .populateFields("lastEditor", ["displayName", "username"])
        .populateFields("space", ["name", "slug"])
        .populateFields("department", ["name"])
        .populateFields("team", ["name"])
        .populateFields(["team", "lead"], ["displayName"]),
    ),
  );
}

type WikiPageRefRow = Pick<WikiPage, "id" | "documentId" | "title" | "slug">;

/**
 * A page's documentId by its slugs (the published page the reader sees):
 * the wiki editor and the history resolve their page with it when the URL
 * carries no `?doc=`. Title only; no body.
 */
export function wikiPageRef(
  spaceSlug: string,
  pageSlug: string,
): Promise<StrapiListResponse<WikiPageRefRow>> {
  return strapi<StrapiListResponse<WikiPageRefRow>>(
    withQuery(
      "/api/wiki-pages",
      strapiQuery()
        .filter(["space", "slug"], "$eq", spaceSlug)
        .filter("slug", "$eq", pageSlug)
        .fields(["title", "slug"]),
    ),
  );
}

/**
 * The published pages of a space with their parents, for the wiki editor's
 * parent picker (§J2: a parent is a page of the same space the caller can
 * read; the cms checks it again and refuses a loop with `parentCycle`).
 * Walks every page, like the index (issue #26); 20 pages x 100.
 */
export function listWikiParentRows(spaceSlug: string): Promise<WalkResult<WikiParentRow>> {
  return walkAllPages<WikiParentRow>(
    (page) =>
      strapi<StrapiListResponse<WikiParentRow>>(
        withQuery(
          "/api/wiki-pages",
          strapiQuery()
            .filter(["space", "slug"], "$eq", spaceSlug)
            .fields(["title", "slug", "order"])
            .populateFields("parent", ["slug"])
            .sort(["title:asc", "id:asc"])
            .page(page, 100),
        ),
      ),
    { maxPages: 20, label: "wiki parents" },
  );
}
