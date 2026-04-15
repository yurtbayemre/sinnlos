import Link from "next/link";
import { api } from "@/lib/strapi";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Departments" };

export default async function DepartmentsPage() {
  const data = await api.departments.list().catch(() => null);
  const items = data?.data ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Departments</h1>
        <p className="text-muted-foreground">Browse departments and their teams.</p>
      </header>

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No departments yet. Create your first one in the Strapi admin.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((d: any) => {
            const attrs = d.attributes ?? d;
            return (
              <Link key={d.id} href={`/departments/${attrs.slug}`}>
                <Card className="h-full">
                  <CardHeader>
                    <div
                      className="mb-3 h-20 rounded-xl"
                      style={{ background: `linear-gradient(135deg, ${attrs.color ?? "#6366f1"}, ${attrs.color ?? "#818cf8"}88)` }}
                    />
                    <CardTitle>{attrs.name}</CardTitle>
                    <CardDescription className="line-clamp-2">
                      {stripHtml(attrs.description) || "No description"}
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

function stripHtml(s?: string | null) {
  if (!s) return "";
  return s.replace(/<[^>]*>?/gm, "");
}
