import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { WikiPageEditor } from "@/components/wiki-editor/wiki-page-editor";
import { appTimeZone } from "@/lib/app-time-zone";
import { loadTargetingOptions } from "@/lib/loaders/manage/options";
import type { ListSearchParams } from "@/lib/loaders/manage/list";
import {
  loadWikiParentOptions,
  loadWikiSpaceRef,
  shadowedWikiPage,
} from "@/lib/loaders/manage/wiki";
import { wikiSpacePath } from "@/lib/manage/wiki-paths";
import { capabilitiesFor } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";
import WikiPage from "../[slug]/page";

type Params = {
  params: Promise<{ space: string }>;
  searchParams: Promise<ListSearchParams>;
};

export async function generateMetadata() {
  const t = await getTranslations("manage.wiki.editor");
  return { title: t("newTitle") };
}

/**
 * A new wiki page in a space (deep-dive decision 06 §J2, §L1; batch 16
 * plan, lane 16C item 5): department heads, team leads and moderators (the
 * `wikiPages.create` capability; the cms also requires that the caller
 * reads the space). Everyone else goes back to the space. The space is the
 * one the reader sees under this address: a space the caller cannot read
 * shows the not-found page.
 *
 * The route shadows a page whose slug is `new`: the authoring links carry
 * `?create=1` (wikiNewPagePath), and without it this address shows that
 * page when the space has one, for every reader (Codex review).
 */
export default async function NewWikiPagePage({ params, searchParams }: Params) {
  const [{ space: spaceSlug }, query] = await Promise.all([params, searchParams]);
  if (query.create !== "1" && (await shadowedWikiPage(spaceSlug))) {
    return <WikiPage params={Promise.resolve({ space: spaceSlug, slug: "new" })} />;
  }
  const viewer = await getViewer();
  const { wikiPages } = capabilitiesFor(viewer.role);
  if (!wikiPages.create) redirect(wikiSpacePath(spaceSlug));
  const t = await getTranslations("manage.wiki.editor");

  const ref = await loadWikiSpaceRef(spaceSlug);
  if (!ref.space) {
    if (!ref.failed) notFound();
    return (
      <div className="space-y-8">
        <ManagePageHeader
          title={t("newTitle")}
          back={wikiSpacePath(spaceSlug)}
          backLabel={t("backToSpace", { space: spaceSlug })}
        />
        <FetchErrorBanner />
      </div>
    );
  }
  const space = ref.space;
  const moderator = wikiPages.edit === "any";
  const [parents, options] = await Promise.all([
    loadWikiParentOptions(space.slug),
    loadTargetingOptions({ departments: moderator, teams: moderator }),
  ]);

  return (
    <div className="space-y-8">
      <ManagePageHeader
        title={t("newTitle")}
        description={t("newDescription", { space: space.name })}
        back={wikiSpacePath(space.slug)}
        backLabel={t("backToSpace", { space: space.name })}
      />
      <WikiPageEditor
        editable={null}
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
