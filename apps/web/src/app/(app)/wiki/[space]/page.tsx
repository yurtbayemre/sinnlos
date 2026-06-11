import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText } from "lucide-react";
import { api } from "@/lib/strapi";
import type { WikiSpace } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  params: Promise<{ space: string }>;
}

export default async function WikiSpacePage({ params }: Props) {
  const { space } = await params;
  // Let fetch errors propagate to app/(app)/error.tsx so the user sees a
  // retry prompt instead of a misleading 404.
  const data = await api.wiki.space(space);
  const entry = data.data?.[0] as WikiSpace | undefined;
  if (!entry) notFound();
  const pages = entry.pages ?? [];

  return (
    <div className="space-y-6">
      <header>
        <Link
          href="/wiki"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Wiki
        </Link>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{entry.name}</h1>
        {entry.description ? (
          <p className="mt-1 text-muted-foreground">{entry.description}</p>
        ) : null}
      </header>

      {pages.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No pages yet in this space"
          hint="Pages created in the Strapi admin will appear here once published."
        />
      ) : (
        <div className="stagger grid gap-4 md:grid-cols-2">
          {pages.map((p) => (
            <Link key={p.id} href={`/wiki/${space}/${p.slug}`} className="focus-card group">
              <Card className="card-lift h-full">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base transition-colors group-hover:text-primary">
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
