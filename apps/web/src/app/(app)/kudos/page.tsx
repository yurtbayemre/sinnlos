import { Award, PartyPopper } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { api, strapi } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import type { Kudos, Celebration, UserLite } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { initials } from "@/lib/utils";
import { GiveKudos } from "@/components/kudos/give-kudos";

export async function generateMetadata() {
  const t = await getTranslations("kudos");
  return { title: t("title") };
}

const VALUE_EMOJI: Record<string, string> = {
  teamwork: "\u{1F91D}",
  innovation: "\u{1F4A1}",
  leadership: "\u{1F31F}",
  "customer-focus": "\u{1F3AF}",
  excellence: "\u{1F3C6}",
};

function relative(dateStr: string | undefined) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const day = 86400000;
  if (diff < day) return "today";
  if (diff < 2 * day) return "yesterday";
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const VALUE_LABEL_KEY: Record<string, string> = {
  teamwork: "teamwork",
  innovation: "innovation",
  leadership: "leadership",
  "customer-focus": "customerFocus",
  excellence: "excellence",
};

export default async function KudosPage() {
  const t = await getTranslations("kudos");
  const [kudosResult, celebrationsResult, peopleResult] = await Promise.all([
    tryFetch(() => api.kudos.list(), "kudos"),
    tryFetch(() => api.celebrations(), "celebrations"),
    tryFetch(
      () =>
        strapi<any[]>(
          "/api/users?populate[department]=true&pagination[pageSize]=200&sort=displayName:asc",
          { noCache: true },
        ),
      "people",
    ),
  ]);

  const kudosList = (kudosResult.data?.data ?? []) as Kudos[];
  const celebrations = (celebrationsResult.data?.data ?? []) as Celebration[];
  const people = (peopleResult.data ?? []) as UserLite[];
  const anyFailed = kudosResult.failed || celebrationsResult.failed;

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("title")}
        description={t("description")}
      >
        <GiveKudos people={people} />
      </PageHeader>

      {anyFailed && <FetchErrorBanner />}

      {celebrations.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <PartyPopper className="h-3.5 w-3.5" />
            {t("celebrations")}
          </div>
          <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {celebrations.map((c) => {
              const name = c.user.displayName ?? c.user.username ?? "Someone";
              return (
                <Card key={`${c.user.id}-${c.type}`}>
                  <CardContent className="flex items-center gap-3 p-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-lg dark:bg-amber-900/30">
                      {"\u{1F382}"}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{name}</div>
                      <div className="text-xs text-muted-foreground">
                        {c.years} year{c.years !== 1 ? "s" : ""} ·{" "}
                        {c.daysUntil === 0
                          ? t("today")
                          : c.daysUntil === 1
                            ? t("tomorrow")
                            : t("inDays", { days: c.daysUntil })}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {kudosList.length === 0 ? (
        <EmptyState
          icon={Award}
          title={t("emptyTitle")}
          hint={t("emptyHint")}
        />
      ) : (
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Award className="h-3.5 w-3.5" />
            {t("recentKudos")}
          </div>
          <div className="stagger space-y-3">
            {kudosList.map((k) => {
              const fromName = k.from?.displayName ?? k.from?.username ?? "Someone";
              const toName = k.to?.displayName ?? k.to?.username ?? "Someone";
              return (
                <Card key={k.id}>
                  <CardContent className="flex items-start gap-4 p-4">
                    <Avatar className="h-10 w-10 shrink-0">
                      <AvatarFallback>{initials(fromName)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">
                        <span className="font-medium">{fromName}</span>
                        {" gave kudos to "}
                        <span className="font-medium">{toName}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                        {k.message}
                      </p>
                      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                          {VALUE_EMOJI[k.value] ?? "\u{2B50}"}{" "}
                          {k.value.replace("-", " ")}
                        </span>
                        <span>{relative(k.createdAt)}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
