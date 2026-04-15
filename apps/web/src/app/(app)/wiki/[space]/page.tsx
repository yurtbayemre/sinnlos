import Link from "next/link";
import { notFound } from "next/navigation";
import { api } from "@/lib/strapi";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  params: Promise<{ space: string }>;
}

export default async function WikiSpacePage({ params }: Props) {
  const { space } = await params;
  const data = await api.wiki.space(space).catch(() => null);
  const entry = data?.data?.[0];
  if (!entry) notFound();
  const attrs = entry.attributes ?? entry;
  const pages = attrs.pages?.data ?? attrs.pages ?? [];

  return (
    <div className="space-y-6">
      <header>
        <div className="text-sm text-muted-foreground">Wiki space</div>
        <h1 className="text-3xl font-semibold tracking-tight">{attrs.name}</h1>
        <p className="text-muted-foreground">{attrs.description}</p>
      </header>

      {pages.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No pages yet in this space.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {pages.map((p: any) => {
            const a = p.attributes ?? p;
            return (
              <Link key={p.id} href={`/wiki/${space}/${a.slug}`}>
                <Card className="h-full">
                  <CardHeader>
                    <CardTitle className="text-base">{a.title}</CardTitle>
                    <CardDescription className="line-clamp-2">
                      {a.summary ?? "—"}
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
