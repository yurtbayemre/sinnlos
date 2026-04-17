import Link from "next/link";
import { notFound } from "next/navigation";
import { api } from "@/lib/strapi";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  params: Promise<{ space: string }>;
}

export default async function WikiSpacePage({ params }: Props) {
  const { space } = await params;
  // Let fetch errors propagate to app/(app)/error.tsx so the user sees a
  // retry prompt instead of a misleading 404.
  const data = await api.wiki.space(space);
  const entry = data.data?.[0];
  if (!entry) notFound();
  const pages = entry.pages ?? [];

  return (
    <div className="space-y-6">
      <header>
        <div className="text-sm text-muted-foreground">Wiki space</div>
        <h1 className="text-3xl font-semibold tracking-tight">{entry.name}</h1>
        <p className="text-muted-foreground">{entry.description}</p>
      </header>

      {pages.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No pages yet in this space.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {pages.map((p: any) => (
            <Link key={p.id} href={`/wiki/${space}/${p.slug}`}>
              <Card className="h-full">
                <CardHeader>
                  <CardTitle className="text-base">{p.title}</CardTitle>
                  <CardDescription className="line-clamp-2">
                    {p.summary ?? "—"}
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
