import Link from "next/link";
import { BookOpen, FilePen, Globe2, Lock, Settings } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";
import { areaAccess } from "@/lib/manage/access";
import { AREA_PATH } from "@/lib/manage/areas";
import { WIKI_DRAFTS_PATH } from "@/lib/manage/wiki-paths";
import { capabilitiesFor } from "@/lib/roles";
import { api } from "@/lib/strapi";
import { getViewer } from "@/lib/viewer";
import { tryFetch } from "@/lib/safe-fetch";
import type { WikiSpace } from "@/lib/types";
import { wikiSpaceIconName } from "@/lib/wiki-content";
import { ICONS } from "@/components/icon-map";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata() {
  const t = await getTranslations("wiki");
  return { title: t("title") };
}

export default async function WikiHomePage() {
  const [t, tCommon, viewer] = await Promise.all([
    getTranslations("wiki"),
    getTranslations("common"),
    getViewer(),
  ]);
  const { data, failed } = await tryFetch(() => api.wiki.spaces(), "wiki");
  const spaces = (data?.data ?? []) as WikiSpace[];
  // Writing (batch 16): the caller's drafts for every role that edits wiki
  // pages; the spaces in /manage for moderators.
  const capabilities = capabilitiesFor(viewer.role);
  const drafts = capabilities.wikiPages.edit !== "none";
  const manage = areaAccess(capabilities, "wiki") !== null;

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")}>
        {drafts || manage ? (
          <div className="flex flex-wrap gap-2">
            {drafts && (
              <Link href={WIKI_DRAFTS_PATH} className={buttonVariants({ variant: "outline" })}>
                <FilePen className="h-4 w-4" aria-hidden="true" />
                {t("myDrafts")}
              </Link>
            )}
            {manage && (
              <Link href={AREA_PATH.wiki} className={buttonVariants({ variant: "outline" })}>
                <Settings className="h-4 w-4" aria-hidden="true" />
                {t("manageSpaces")}
              </Link>
            )}
          </div>
        ) : null}
      </PageHeader>

      {failed && <FetchErrorBanner />}

      {spaces.length === 0 ? (
        <EmptyState icon={BookOpen} title={t("emptySpacesTitle")} hint={t("emptySpacesHint")} />
      ) : (
        // grid-cols-1 and min-w-0: below sm a grid without a column template
        // sizes its items by content (min-width: auto), so a long description
        // behind `truncate` widened the card past a 360 px screen.
        <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {spaces.map((s) => {
            // DA02: the space's icon through the shared icon map (BookOpen otherwise).
            const Icon = ICONS[wikiSpaceIconName(s.icon)];
            return (
              <Link key={s.id} href={`/wiki/${s.slug}`} className="focus-card group min-w-0">
                <Card interactive className="card-lift h-full">
                  <CardHeader>
                    <div
                      aria-hidden="true"
                      className="mb-1 flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary"
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <CardTitle as="h2" className="transition-colors group-hover:text-primary">
                      {s.name}
                    </CardTitle>
                    <CardDescription className="flex items-center gap-1.5">
                      {s.visibility === "public" ? (
                        <Globe2 className="h-3 w-3 shrink-0" aria-hidden="true" />
                      ) : (
                        <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
                      )}
                      <span className="truncate">{s.description ?? tCommon("noDescription")}</span>
                    </CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
