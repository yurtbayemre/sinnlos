import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { api } from "@/lib/strapi";
import { isReadDenied } from "@/lib/roles";
import { tryFetch } from "@/lib/safe-fetch";
import { getViewer } from "@/lib/viewer";
import type { Team } from "@/lib/types";
import { initials, stripHtml } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { SectionUnavailable } from "@/components/section-unavailable";

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const t = await getTranslations("teams");
  // No read for a role that cannot read teams (SH02).
  if (isReadDenied((await getViewer()).role, "teams")) return { title: t("title") };
  // Same GET as the page's, sent once per render (Next's fetch dedupe).
  const { data } = await tryFetch(() => api.teams.one(slug), "team-meta");
  const entry = data?.data?.[0] as Team | undefined;
  return { title: entry?.name ?? t("title") };
}

export default async function TeamPage({ params }: Props) {
  const { slug } = await params;
  const t = await getTranslations("teams");
  const tCommon = await getTranslations("common");
  // A role without team.find (guest) gets no request and an explanation
  // instead of the error page (SH02).
  if (isReadDenied((await getViewer()).role, "teams")) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("title")} />
        <SectionUnavailable />
      </div>
    );
  }
  // Detail-page error strategy (WD07, same on all detail pages): fetch
  // errors propagate to app/(app)/error.tsx, whose "Try again" fetches the
  // page again, instead of a misleading 404; an unknown slug is a 404.
  const data = await api.teams.one(slug);
  const entry = data.data?.[0] as Team | undefined;
  if (!entry) notFound();

  const members = entry.members ?? [];
  const lead = entry.lead;
  const dept = entry.department;

  return (
    <div className="space-y-8">
      <header>
        <div className="text-sm font-medium text-muted-foreground">{dept?.name ?? ""}</div>
        <h1 className="text-3xl font-semibold tracking-tight">{entry.name}</h1>
        <p className="mt-1 text-muted-foreground">
          {stripHtml(entry.description) || tCommon("noDescription")}
        </p>
      </header>

      <section className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>{t("lead")}</CardTitle>
          </CardHeader>
          <CardContent>
            {lead ? (
              <Link
                href={`/people/${lead.id}`}
                className="focus-card -m-2 flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-accent/50"
              >
                <Avatar>
                  <AvatarFallback>{initials(lead.displayName ?? lead.username)}</AvatarFallback>
                </Avatar>
                <div>
                  <div className="font-medium">{lead.displayName ?? lead.username}</div>
                  <div className="text-xs text-muted-foreground">{lead.jobTitle ?? lead.email}</div>
                </div>
              </Link>
            ) : (
              <p className="text-sm text-muted-foreground">{t("noLeadAssigned")}</p>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("members")}</CardTitle>
            <CardDescription>{tCommon("member", { count: members.length })}</CardDescription>
          </CardHeader>
          <CardContent className="stagger grid gap-3 sm:grid-cols-2">
            {members.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noMembersYet")}</p>
            ) : (
              members.map((m) => (
                <Link
                  key={m.id}
                  href={`/people/${m.id}`}
                  className="focus-card flex items-center gap-3 rounded-xl border p-3 transition-colors hover:bg-accent/50"
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
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
