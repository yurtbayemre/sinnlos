import { notFound } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/strapi";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initials } from "@/lib/utils";

interface Props {
  params: Promise<{ slug: string }>;
}

export default async function DepartmentPage({ params }: Props) {
  const { slug } = await params;
  // Let fetch errors propagate to app/(app)/error.tsx so the user sees a
  // retry prompt instead of a misleading 404.
  const data = await api.departments.one(slug);
  const entry = data.data?.[0];
  if (!entry) notFound();

  const teams = entry.teams ?? [];
  const members = entry.members ?? [];
  const head = entry.head;
  const color = entry.color ?? "#6366f1";

  return (
    <div className="space-y-8">
      <div
        className="h-40 rounded-2xl"
        style={{ background: `linear-gradient(135deg, ${color}, ${color}66)` }}
      />
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">{entry.name}</h1>
        <p className="mt-1 text-muted-foreground">
          {stripHtml(entry.description) || "No description yet."}
        </p>
      </header>

      <section className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Teams</CardTitle>
            <CardDescription>{teams.length} teams in this department</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {teams.length === 0 ? (
              <p className="text-sm text-muted-foreground">No teams yet.</p>
            ) : (
              teams.map((t: any) => (
                <Link
                  key={t.id}
                  href={`/teams/${t.slug}`}
                  className="rounded-xl border p-4 transition hover:bg-accent"
                >
                  <div className="font-medium">{t.name}</div>
                  <div className="text-xs text-muted-foreground line-clamp-1">
                    {stripHtml(t.description) || "—"}
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Head</CardTitle>
          </CardHeader>
          <CardContent>
            {head ? (
              <div className="flex items-center gap-3">
                <Avatar>
                  {head.avatar?.url ? <AvatarImage src={head.avatar.url} /> : null}
                  <AvatarFallback>{initials(head.displayName ?? head.username)}</AvatarFallback>
                </Avatar>
                <div>
                  <div className="font-medium">{head.displayName ?? head.username}</div>
                  <div className="text-xs text-muted-foreground">{head.jobTitle ?? head.email}</div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No head assigned.</p>
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Members</h2>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No members yet.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {members.map((m: any) => (
              <div key={m.id} className="flex items-center gap-3 rounded-xl border p-3">
                <Avatar>
                  <AvatarFallback>{initials(m.displayName ?? m.username)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <div className="truncate font-medium">{m.displayName ?? m.username}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {m.jobTitle ?? m.email}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function stripHtml(s?: string | null) {
  if (!s) return "";
  return s.replace(/<[^>]*>?/gm, "");
}
