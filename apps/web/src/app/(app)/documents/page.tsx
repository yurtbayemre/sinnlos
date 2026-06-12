import { FileText, Download, File } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { api } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import { STRAPI_PUBLIC_URL } from "@/lib/config";
import type { Document } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";

export async function generateMetadata() {
  const t = await getTranslations("documents");
  return { title: t("title") };
}

function formatSize(bytes?: number) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export default async function DocumentsPage() {
  const [t, tCommon] = await Promise.all([
    getTranslations("documents"),
    getTranslations("common"),
  ]);
  const { data, failed } = await tryFetch(() => api.documents.list(), "documents");
  const docs = (data?.data ?? []) as Document[];

  const grouped = new Map<string, Document[]>();
  for (const d of docs) {
    const cat = d.category ?? "other";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(d);
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("title")}
        description={t("description")}
      />

      {failed && <FetchErrorBanner />}

      {docs.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={t("emptyTitle")}
          hint={t("emptyHint")}
        />
      ) : (
        Array.from(grouped.entries()).map(([category, items]) => (
          <section key={category} className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <FileText className="h-3.5 w-3.5" />
              {t.has(category) ? t(category as any) : category}
            </div>
            <div className="stagger space-y-2">
              {items.map((doc) => {
                const fileUrl = doc.file?.url
                  ? doc.file.url.startsWith("http")
                    ? doc.file.url
                    : `${STRAPI_PUBLIC_URL}${doc.file.url}`
                  : null;
                return (
                  <Card key={doc.id}>
                    <CardContent className="flex items-center gap-4 p-4">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <File className="h-5 w-5" aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{doc.title}</div>
                        {doc.description && (
                          <div className="mt-0.5 truncate text-sm text-muted-foreground">
                            {doc.description}
                          </div>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          {doc.file?.name && <span>{doc.file.name}</span>}
                          {doc.file?.size && <span>{formatSize(doc.file.size)}</span>}
                          {doc.updatedAt && (
                            <span>
                              {tCommon("updated")}{" "}
                              {new Date(doc.updatedAt).toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              })}
                            </span>
                          )}
                        </div>
                      </div>
                      {fileUrl && (
                        <a
                          href={fileUrl}
                          download
                          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition hover:bg-muted"
                          title={tCommon("download")}
                        >
                          <Download className="h-4 w-4" aria-hidden="true" />
                        </a>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
