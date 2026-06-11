import { notFound } from "next/navigation";
import { api } from "@/lib/strapi";
import type { Team } from "@/lib/types";
import { initials, stripHtml } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  params: Promise<{ slug: string }>;
}

export default async function TeamPage({ params }: Props) {
  const { slug } = await params;
  // Let fetch errors propagate to app/(app)/error.tsx so the user sees a
  // retry prompt instead of a misleading 404.
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
          {stripHtml(entry.description) || "No description yet."}
        </p>
      </header>

      <section className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Lead</CardTitle>
          </CardHeader>
          <CardContent>
            {lead ? (
              <div className="flex items-center gap-3">
                <Avatar>
                  <AvatarFallback>{initials(lead.displayName ?? lead.username)}</AvatarFallback>
                </Avatar>
                <div>
                  <div className="font-medium">{lead.displayName ?? lead.username}</div>
                  <div className="text-xs text-muted-foreground">{lead.jobTitle ?? lead.email}</div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No lead assigned.</p>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Members</CardTitle>
            <CardDescription>
              {members.length} {members.length === 1 ? "member" : "members"}
            </CardDescription>
          </CardHeader>
          <CardContent className="stagger grid gap-3 sm:grid-cols-2">
            {members.length === 0 ? (
              <p className="text-sm text-muted-foreground">No members yet.</p>
            ) : (
              members.map((m) => (
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
              ))
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
