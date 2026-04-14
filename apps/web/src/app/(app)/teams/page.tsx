import Link from "next/link";
import { api } from "@/lib/strapi";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Teams" };

export default async function TeamsPage() {
  const data = await api.teams.list().catch(() => null);
  const items = data?.data ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Teams</h1>
        <p className="text-muted-foreground">All teams across the company.</p>
      </header>

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No teams yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((t: any) => {
            const attrs = t.attributes ?? t;
            const dept = attrs.department?.data?.attributes ?? attrs.department;
            return (
              <Link key={t.id} href={`/teams/${attrs.slug}`}>
                <Card className="h-full">
                  <CardHeader>
                    <CardTitle>{attrs.name}</CardTitle>
                    <CardDescription>
                      {dept?.name ? `${dept.name} · ` : ""}
                      {attrs.members?.length ?? attrs.members?.data?.length ?? 0} members
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
