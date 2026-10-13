import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { WikiPageEditor } from "@/components/wiki-editor/wiki-page-editor";
import { appTimeZone } from "@/lib/app-time-zone";
import type { ListSearchParams } from "@/lib/loaders/manage/list";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";
import {
  loadWikiPageEditable,
  loadWikiParentOptions,
  resolveWikiPageId,
} from "@/lib/loaders/manage/wiki";
import { wikiEditPath, wikiPagePath, wikiSpacePath } from "@/lib/manage/wiki-paths";
import { capabilitiesFor } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";

type Props = {
  params: Promise<{ space: string; slug: string }>;
  searchParams: Promise<ListSearchParams>;
};

export async function generateMetadata() {
  const t = await getTranslations("manage.wiki.editor");
  return { title: t("editTitle") };
}

/**
 * The wiki editor for one page (deep-dive decision 06 §J2, §L1, §L4; batch
 * 16 plan, lane 16C item 5). The page is the URL's `?doc=` (a draft that
 * was never published has no published route; /wiki/drafts and the tree
 * link that way), else the published page of the URL's slugs. `editable`
 * decides: the page's author, its department's head, its team's lead and
 * moderators get the form (their class's fields), everyone else the
 * not-found page, which says nothing about whether the page exists. A role
 * that edits no wiki page goes back to the page. The URL is kept canonical
 * (the page's space and slug).
 */
export default async function EditWikiPagePage({ params, searchParams }: Props) {
  const [{ space: spaceSlug, slug }, query] = await Promise.all([params, searchParams]);
  const viewer = await getViewer();
  const { wikiPages } = capabilitiesFor(viewer.role);
  if (wikiPages.edit === "none") redirect(wikiPagePath(spaceSlug, slug));
  const t = await getTranslations("manage.wiki.editor");
  const failed = (
    <div className="space-y-8">
      <ManagePageHeader
        title={t("editTitle")}
        back={wikiSpacePath(spaceSlug)}
        backLabel={t("backToSpace", { space: spaceSlug })}
      />
      <FetchErrorBanner />
    </div>
  );

  const ref = await resolveWikiPageId(spaceSlug, slug, query.doc);
  if (!ref.documentId) {
    if (ref.failed) return failed;
    notFound();
  }
  const load = await loadWikiPageEditable(ref.documentId);
  if (load.state === "notFound") notFound();
  if (load.state === "failed") return failed;
  const { editable } = load;
  if (editable.space && (editable.space.slug !== spaceSlug || editable.slug !== slug)) {
    redirect(wikiEditPath(editable.space.slug, editable.slug, editable.documentId));
  }
  const space = editable.space ?? { documentId: "", name: spaceSlug, slug: spaceSlug };
  const moderator = editable.roleClass === "moderator";
  const [parents, options] = await Promise.all([
    loadWikiParentOptions(space.slug, editable.documentId),
    loadTargetingOptions({ departments: moderator, teams: moderator }),
  ]);

  return (
    <div className="space-y-8">
      <ManagePageHeader
        title={t("editTitle")}
        description={editable.space ? t("inSpace", { space: space.name }) : t("noSpace")}
        back={wikiSpacePath(space.slug)}
        backLabel={t("backToSpace", { space: space.name })}
      />
      <WikiPageEditor
        key={editable.documentId}
        editable={editable}
        space={space}
        wikiPages={wikiPages}
        timeZone={appTimeZone()}
        parentOptions={parents.options}
        parentsFailed={parents.failed}
        parentsTruncated={parents.truncated}
        departments={options.departments}
        teams={options.teams}
        optionsFailed={options.failed}
        optionsTruncated={options.truncated}
      />
    </div>
  );
}
