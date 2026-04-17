import Link from "next/link";
import { api } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import { FetchErrorBanner } from "@/components/fetch-error";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Wiki" };

export default async function WikiHomePage() {
  const { data, failed } = await tryFetch(() => api.wiki.spaces(), "wiki");
  const spaces = data?.data ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Wiki</h1>
        <p className="text-muted-foreground">
          Knowledge base, handbooks and how-tos organised in spaces.
        </p>
      </header>

      {failed && <FetchErrorBanner />}

      {spaces.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No wiki spaces yet. Create one from the Strapi admin.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {spaces.map((s: any) => (
            <Link key={s.id} href={`/wiki/${s.slug}`}>
              <Card className="h-full">
                <CardHeader>
                  <CardTitle>{s.name}</CardTitle>
                  <CardDescription>
                    {s.description ?? "No description"} · {s.visibility}
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
