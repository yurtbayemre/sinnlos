/**
 * The wiki's authoring URLs (deep-dive decision 06 §L1; batch 16 plan,
 * lane 16C items 5 and 6). Pure; usable from server and client code.
 *
 *   /wiki/[space]/[slug]                      the published page
 *   /wiki/[space]/new                          a new page (DH, TL, M)
 *   /wiki/[space]/[slug]/edit?doc=<id>         the wiki editor
 *   /wiki/[space]/[slug]/history?doc=<id>&rev= the history
 *   /wiki/drafts?mine=1                        the caller's drafts
 *
 * `/wiki/[space]/new` and `/wiki/drafts` are routes inside the readers'
 * slug namespace: a page whose slug is `new` and a space whose slug is
 * `drafts` would be shadowed. So the authoring links carry a marker
 * (`?create=1`, `?mine=1`), and without it those two routes show the page
 * or the space when one exists (lib/loaders/manage/wiki.ts
 * shadowedWikiPage, shadowedWikiSpace); a reader's link keeps working.
 *
 * The editor and the history carry the page's documentId (`?doc=`): a page
 * that was never published has no published slug route to resolve it by,
 * and `editable` decides access anyway. Without `?doc=` the page resolves
 * through the published page of the URL's slugs.
 */
import type { Route } from "next";

const segment = (value: string) => encodeURIComponent(value);

export const WIKI_DRAFTS_PATH = "/wiki/drafts?mine=1" as Route;

export function wikiSpacePath(spaceSlug: string): Route {
  return `/wiki/${segment(spaceSlug)}` as Route;
}

export function wikiPagePath(spaceSlug: string, slug: string): Route {
  return `/wiki/${segment(spaceSlug)}/${segment(slug)}` as Route;
}

export function wikiNewPagePath(spaceSlug: string): Route {
  return `/wiki/${segment(spaceSlug)}/new?create=1` as Route;
}

export function wikiEditPath(spaceSlug: string, slug: string, documentId?: string): Route {
  const query = documentId ? `?doc=${segment(documentId)}` : "";
  return `/wiki/${segment(spaceSlug)}/${segment(slug)}/edit${query}` as Route;
}

export function wikiHistoryPath(
  spaceSlug: string,
  slug: string,
  documentId?: string,
  { revision, page }: { revision?: number; page?: number } = {},
): Route {
  const params = new URLSearchParams();
  if (documentId) params.set("doc", documentId);
  if (page && page > 1) params.set("page", String(page));
  if (revision) params.set("rev", String(revision));
  const query = params.toString();
  return `/wiki/${segment(spaceSlug)}/${segment(slug)}/history${query ? `?${query}` : ""}` as Route;
}
