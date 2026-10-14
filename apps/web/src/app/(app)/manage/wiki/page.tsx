import { BookOpen } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ListPagination, ListToolbar } from "@/components/manage/list";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { WikiSpaceList } from "@/components/manage/wiki-lists";
import { canDo } from "@/lib/manage/access";
import { AREA_NEW_PATH } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import type { ListSearchParams } from "@/lib/loaders/manage/list";
import { loadWikiSpaceList, parseWikiSpaceFilters } from "@/lib/loaders/manage/wiki";

export async function generateMetadata() {
  const t = await getTranslations("manage.wiki");
  return { title: t("title") };
}

/**
 * The wiki's spaces in /manage (deep-dive decision 06 §L1, §J1; batch 16
 * plan, lane 16C item 4): moderators only (the `wikiSpaces` capability; a
 * department author never gets here). A title search and pages of 25;
 * each space leads to its page tree. Spaces are always published, so the
 * list has no status tabs.
 */
export default async function ManageWikiPage({
  searchParams,
}: {
  searchParams: Promise<ListSearchParams>;
}) {
  const { access } = await areaGate("wiki");
  const [t, tc] = await Promise.all([
    getTranslations("manage.wiki"),
    getTranslations("manage.common"),
  ]);
  const filters = parseWikiSpaceFilters(await searchParams);
  const view = await loadWikiSpaceList(filters);
  const listFilters = { status: null, owner: null, q: filters.q, page: filters.page };

  return (
    <div className="space-y-6">
      <ManagePageHeader
        title={t("title")}
        description={t("description")}
        action={canDo(access, "create") ? { href: AREA_NEW_PATH.wiki, label: t("new") } : undefined}
      />
      {view.failed && <FetchErrorBanner />}
      <ListToolbar area="wiki" filters={listFilters} tabs={[]} ownerFilter={false} />
      {view.empty ? (
        filters.q ? (
          <p className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            {tc("list.emptyFiltered")}
          </p>
        ) : (
          <EmptyState icon={BookOpen} title={t("emptyTitle")} hint={t("emptyHint")} />
        )
      ) : view.rows.length > 0 ? (
        <WikiSpaceList rows={view.rows} />
      ) : null}
      {!view.failed && !view.empty && (
        <ListPagination area="wiki" filters={listFilters} pagination={view.pagination} />
      )}
    </div>
  );
}
