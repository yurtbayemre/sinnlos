import { notFound } from "next/navigation";
import Link from "next/link";
import { Users2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { api } from "@/lib/strapi";
import type { Department } from "@/lib/types";
import { initials, stripHtml } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface Props {
  params: Promise<{ slug: string }>;
}

export default async function DepartmentPage({ params }: Props) {
  const { slug } = await params;
  const t = await getTranslations("departments");
  const tTeams = await getTranslations("teams");
  const tCommon = await getTranslations("common");
  // Let fetch errors propagate to app/(app)/error.tsx so the user sees a
  // retry prompt instead of a misleading 404.
  const data = await api.departments.one(slug);
  const entry = data.data?.[0] as Department | undefined;
  if (!entry) notFound();

  const teams = entry.teams ?? [];
  const members = entry.members ?? [];
  const head = entry.head;
  const color = entry.color ?? "#6366f1";

  return (
    <div className="space-y-8">
      <div
        aria-hidden="true"
        className="h-40 rounded-2xl"
        style={{ background: `linear-gradient(135deg, ${color}, ${color}66)` }}
      />
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">{entry.name}</h1>
        <p className="mt-1 text-muted-foreground">
          {stripHtml(entry.description) || t("noDescriptionYet")}
        </p>
      </header>

      <section className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{tTeams("title")}</CardTitle>
            <CardDescription>
              {tCommon("team", { count: teams.length })} {tCommon("inThisDepartment")}
            </CardDescription>
          </CardHeader>
          <CardContent className="stagger grid gap-3 sm:grid-cols-2">
            {teams.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noTeamsYet")}</p>
            ) : (
              teams.map((tm) => (
                <Link
                  key={tm.id}
                  href={`/teams/${tm.slug}`}
                  className="focus-card group rounded-xl border p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:bg-accent hover:shadow-sm"
                >
                  <div className="flex items-center gap-2 font-medium transition-colors group-hover:text-primary">
                    <Users2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    {tm.name}
                  </div>
                  <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                    {stripHtml(tm.description) || "—"}
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("head")}</CardTitle>
          </CardHeader>
          <CardContent>
            {head ? (
              <div className="flex items-center gap-3">
                <Avatar>
                  {head.avatar?.url ? (
                    <AvatarImage
                      src={head.avatar.url}
                      alt={head.displayName ?? head.username ?? "Department head"}
                    />
                  ) : null}
                  <AvatarFallback>{initials(head.displayName ?? head.username)}</AvatarFallback>
                </Avatar>
                <div>
                  <div className="font-medium">{head.displayName ?? head.username}</div>
                  <div className="text-xs text-muted-foreground">{head.jobTitle ?? head.email}</div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("noHeadAssigned")}</p>
            )}
          </CardContent>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">{t("members")}</h2>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noMembersYet")}</p>
        ) : (
          <div className="stagger grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {members.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-3 rounded-xl border p-3 transition-colors hover:bg-accent/50"
              >
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
