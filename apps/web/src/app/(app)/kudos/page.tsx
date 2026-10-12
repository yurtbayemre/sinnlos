import { Award, PartyPopper } from "lucide-react";
import type { Messages } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { appTimeZone } from "@/lib/app-time-zone";
import { loadKudos } from "@/lib/loaders/kudos";
import { isReadDenied } from "@/lib/roles";
import { getSession } from "@/lib/session";
import { getViewer } from "@/lib/viewer";
import { relativeTime } from "@/lib/relative-time";
import type { KudosValue } from "@/lib/types";
import { initials } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { SectionUnavailablePage } from "@/components/section-unavailable";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
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

/** The label key (namespace `kudos`) of each kudos value, typed against the catalog. */
const VALUE_LABEL_KEY = {
  teamwork: "teamwork",
  innovation: "innovation",
  leadership: "leadership",
  "customer-focus": "customerFocus",
  excellence: "excellence",
} as const satisfies Record<KudosValue, keyof Messages["kudos"]>;

/** A value this web has a label for (the cms may know a newer one). */
function isKudosValue(value: string): value is KudosValue {
  return Object.hasOwn(VALUE_LABEL_KEY, value);
}

export default async function KudosPage() {
  const t = await getTranslations("kudos");
  const tCommon = await getTranslations("common");
  const tRel = await getTranslations("relativeTime");
  const locale = await getLocale();
  const timeZone = appTimeZone();
  const relative = (d: string | undefined) => relativeTime(d, tRel, { locale, timeZone });
  const [session, viewer] = await Promise.all([getSession(), getViewer()]);
  // A role without kudos.find (guest) gets no request and an explanation
  // instead of the CMS's 403 as an error banner (SH02).
  if (isReadDenied(viewer.role, "kudos")) {
    return <SectionUnavailablePage title={t("title")} description={t("description")} />;
  }
  const selfId = typeof session?.user?.id === "number" ? session.user.id : null;
  // The reads and the picker's DTO: lib/loaders/kudos.ts (WD03).
  const view = await loadKudos(viewer.role, selfId);

  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("description")}>
        <GiveKudos people={view.recipients} />
      </PageHeader>

      {view.failed && <FetchErrorBanner />}

      {view.celebrations.length > 0 && (
        <section className="space-y-3">
          <SectionLabel icon={PartyPopper}>{t("celebrations")}</SectionLabel>
          <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {view.celebrations.map((c) => {
              const name = c.name ?? tCommon("unknown");
              const isBirthday = c.type === "birthday";
              return (
                <Card key={c.key}>
                  <CardContent className="flex items-center gap-3 p-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-lg">
                      {isBirthday ? "\u{1F382}" : "\u{1F389}"}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{name}</div>
                      <div className="text-xs text-muted-foreground">
                        {isBirthday ? t("birthday") : t("yearsCount", { years: c.years ?? 0 })} ·{" "}
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

      {view.empty ? (
        <EmptyState icon={Award} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : view.kudos.length > 0 ? (
        <section className="space-y-3">
          <SectionLabel icon={Award}>{t("recentKudos")}</SectionLabel>
          <div className="stagger space-y-3">
            {view.kudos.map((k) => {
              const fromName = k.fromName ?? tCommon("unknown");
              const toName = k.toName ?? tCommon("unknown");
              return (
                <Card key={k.id}>
                  <CardContent className="flex items-start gap-4 p-4">
                    <Avatar className="h-10 w-10 shrink-0">
                      <AvatarFallback>{initials(fromName)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">
                        {t("gaveKudosTo", { from: fromName, to: toName })}
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                        {k.message}
                      </p>
                      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                          {VALUE_EMOJI[k.value] ?? "\u{2B50}"}{" "}
                          {isKudosValue(k.value) ? t(VALUE_LABEL_KEY[k.value]) : k.value}
                        </span>
                        <span>{relative(k.createdAt ?? undefined)}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
