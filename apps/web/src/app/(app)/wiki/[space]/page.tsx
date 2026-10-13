import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText, Plus, Settings } from "lucide-react";
import { getTranslations } from "next-intl/server";
import type { Route } from "next";
import { buttonVariants } from "@/components/ui/button";
import { areaAccess } from "@/lib/manage/access";
import { areaItemPath } from "@/lib/manage/areas";
import { wikiNewPagePath } from "@/lib/manage/wiki-paths";
import { capabilitiesFor } from "@/lib/roles";
import { api } from "@/lib/strapi";
import { getViewer } from "@/lib/viewer";
import type { WikiSpace } from "@/lib/types";
import { sortWikiPages, wikiSpaceIconName } from "@/lib/wiki-content";
import { ICONS } from "@/components/icon-map";
import { EmptyState } from "@/components/empty-state";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  params: Promise<{ space: string }>;
}

export default async function WikiSpacePage({ params }: Props) {
  const { space } = await params;
  const [t, viewer] = await Promise.all([getTranslations("wiki"), getViewer()]);
  // Let fetch errors propagate to app/(app)/error.tsx so the user sees a
  // retry prompt instead of a misleading 404.
  const data = await api.wiki.space(space);
  const entry = data.data?.[0] as WikiSpace | undefined;
  if (!entry) notFound();
  // Writing (batch 16): a new page for department heads, team leads and
  // moderators (the cms also requires that they read this space, which
  // they do on this page); the space's tree in /manage for moderators.
  const capabilities = capabilitiesFor(viewer.role);
  const manageSpace = areaAccess(capabilities, "wiki") !== null && !!entry.documentId;
  // DA02: the author-set order, ties by title (lib/wiki-content.ts).
  const pages = sortWikiPages(entry.pages ?? []);
  const SpaceIcon = ICONS[wikiSpaceIconName(entry.icon)];

  return (
    <div className="space-y-6">
      <header>
        <Link
          href="/wiki"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t("title")}
        </Link>
        <h1 className="mt-1 flex items-center gap-3 text-3xl font-semibold tracking-tight">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
          >
            <SpaceIcon className="h-5 w-5" />
          </span>
          {entry.name}
        </h1>
        {entry.description ? (
          <p className="mt-1 text-muted-foreground">{entry.description}</p>
        ) : null}
        {capabilities.wikiPages.create || manageSpace ? (
          <div role="group" aria-label={t("spaceActions")} className="mt-4 flex flex-wrap gap-2">
            {capabilities.wikiPages.create && (
              <Link
                href={wikiNewPagePath(space)}
                className={buttonVariants({ variant: "default", size: "sm" })}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t("newPage")}
              </Link>
            )}
            {manageSpace && (
              <Link
                href={areaItemPath("wiki", entry.documentId as string) as Route}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                <Settings className="h-4 w-4" aria-hidden="true" />
                {t("manageSpace")}
              </Link>
            )}
          </div>
        ) : null}
      </header>

      {pages.length === 0 ? (
        <EmptyState icon={FileText} title={t("emptyPagesTitle")} hint={t("emptyPagesHint")} />
      ) : (
        <div className="stagger grid gap-4 md:grid-cols-2">
          {pages.map((p) => (
            <Link key={p.id} href={`/wiki/${space}/${p.slug}`} className="focus-card group">
              <Card interactive className="card-lift h-full">
                <CardHeader>
                  <CardTitle
                    as="h2"
                    className="flex items-center gap-2 text-base transition-colors group-hover:text-primary"
                  >
                    <FileText
                      className="h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    {p.title}
                  </CardTitle>
                  <CardDescription className="line-clamp-2">{p.summary ?? "—"}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
