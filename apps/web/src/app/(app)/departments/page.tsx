import Link from "next/link";
import { api } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import { FetchErrorBanner } from "@/components/fetch-error";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Departments" };

export default async function DepartmentsPage() {
  const { data, failed } = await tryFetch(() => api.departments.list(), "departments");
  const items = data?.data ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Departments</h1>
        <p className="text-muted-foreground">Browse departments and their teams.</p>
      </header>

      {failed && <FetchErrorBanner />}

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No departments yet. Create your first one in the Strapi admin.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((d: any) => (
            <Link key={d.id} href={`/departments/${d.slug}`}>
              <Card className="h-full">
                <CardHeader>
                  <div
                    className="mb-3 h-20 rounded-xl"
                    style={{ background: `linear-gradient(135deg, ${d.color ?? "#6366f1"}, ${d.color ?? "#818cf8"}88)` }}
                  />
                  <CardTitle>{d.name}</CardTitle>
                  <CardDescription className="line-clamp-2">
                    {stripHtml(d.description) || "No description"}
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

function stripHtml(s?: string | null) {
  if (!s) return "";
  return s.replace(/<[^>]*>?/gm, "");
}
