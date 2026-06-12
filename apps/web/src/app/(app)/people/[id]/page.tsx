import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  Building2,
  Mail,
  MapPin,
  Phone,
  Users2,
} from "lucide-react";
import { getTranslations } from "next-intl/server";
import { strapi } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import type { UserLite } from "@/lib/types";
import { initials } from "@/lib/utils";
import { FetchErrorBanner } from "@/components/fetch-error";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data } = await tryFetch(
    () =>
      strapi<any>(
        `/api/users/${id}?populate[department]=true&populate[avatar]=true`,
        { noCache: true },
      ),
    "person-meta",
  );
  return { title: data?.displayName ?? data?.username ?? "Person" };
}

export default async function PersonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [t, tNav] = await Promise.all([
    getTranslations("people"),
    getTranslations("nav"),
  ]);
  const { data, failed } = await tryFetch(
    () =>
      strapi<any>(
        `/api/users/${id}?populate[department]=true&populate[avatar]=true&populate[manager][populate][avatar]=true&populate[directReports][populate][avatar]=true&populate[teams][populate][department]=true&populate[role]=true`,
        { noCache: true },
      ),
    "person",
  );

  if (!data && !failed) notFound();

  const person = data as UserLite | null;
  if (!person) {
    return (
      <div className="space-y-6">
        {failed && <FetchErrorBanner />}
      </div>
    );
  }

  const name = person.displayName ?? person.username ?? person.email ?? "Unknown";
  const avatarUrl = person.avatar?.url
    ? person.avatar.url.startsWith("http")
      ? person.avatar.url
      : person.avatar.url
    : null;

  return (
    <div className="space-y-6">
      <Link
        href="/people"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {tNav("people")}
      </Link>

      {failed && <FetchErrorBanner />}

      <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
        <Avatar className="h-24 w-24">
          {avatarUrl ? <AvatarImage src={avatarUrl} alt={name} /> : null}
          <AvatarFallback className="text-2xl">{initials(name)}</AvatarFallback>
        </Avatar>
        <div className="text-center sm:text-left">
          <h1 className="text-3xl font-semibold tracking-tight">{name}</h1>
          {person.jobTitle && (
            <p className="mt-1 text-lg text-muted-foreground">{person.jobTitle}</p>
          )}
          {person.department?.name && (
            <Link
              href={`/departments/${person.department.slug}`}
              className="mt-1 inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              <Building2 className="h-3.5 w-3.5" />
              {person.department.name}
            </Link>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* Contact info */}
          <Card>
            <CardHeader>
              <CardTitle>{t("contact")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {person.email && (
                <div className="flex items-center gap-3 text-sm">
                  <Mail className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <a href={`mailto:${person.email}`} className="hover:underline">
                    {person.email}
                  </a>
                </div>
              )}
              {person.phone && (
                <div className="flex items-center gap-3 text-sm">
                  <Phone className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <a href={`tel:${person.phone}`} className="hover:underline">
                    {person.phone}
                  </a>
                </div>
              )}
              {person.officeLocation && (
                <div className="flex items-center gap-3 text-sm">
                  <MapPin className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <span>{person.officeLocation}</span>
                </div>
              )}
              {!person.email && !person.phone && !person.officeLocation && (
                <p className="text-sm text-muted-foreground">{t("noContactInfo")}</p>
              )}
            </CardContent>
          </Card>

          {/* Teams */}
          {(person as any).teams?.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>{t("teams")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {((person as any).teams as any[]).map((t: any) => (
                    <Link
                      key={t.id}
                      href={`/teams/${t.slug}`}
                      className="flex items-center gap-3 rounded-lg p-2 text-sm transition hover:bg-muted"
                    >
                      <Users2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      <div>
                        <div className="font-medium">{t.name}</div>
                        {t.department?.name && (
                          <div className="text-xs text-muted-foreground">
                            {t.department.name}
                          </div>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sidebar: Manager + Direct Reports */}
        <div className="space-y-6">
          {person.manager && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("reportsTo")}</CardTitle>
              </CardHeader>
              <CardContent>
                <PersonMini user={person.manager} />
              </CardContent>
            </Card>
          )}

          {person.directReports && person.directReports.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("directReports")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {person.directReports.map((r) => (
                  <PersonMini key={r.id} user={r} />
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function PersonMini({ user }: { user: UserLite }) {
  const name = user.displayName ?? user.username ?? user.email ?? "Unknown";
  const avatarUrl = user.avatar?.url ?? null;
  return (
    <Link
      href={`/people/${user.id}`}
      className="flex items-center gap-3 rounded-lg p-2 transition hover:bg-muted"
    >
      <Avatar className="h-9 w-9">
        {avatarUrl ? <AvatarImage src={avatarUrl} alt={name} /> : null}
        <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{name}</div>
        {user.jobTitle && (
          <div className="truncate text-xs text-muted-foreground">
            {user.jobTitle}
          </div>
        )}
      </div>
    </Link>
  );
}
