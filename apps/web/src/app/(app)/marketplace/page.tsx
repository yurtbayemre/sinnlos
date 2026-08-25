import Link from "next/link";
import { ImageIcon, MapPin, Plus, ShoppingBag, Tag } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { api } from "@/lib/strapi";
import { mediaUrl } from "@/lib/config";
import { tryFetch } from "@/lib/safe-fetch";
import { relativeTime } from "@/lib/relative-time";
import {
  AD_CATEGORIES,
  AD_CATEGORY_KEYS,
  isClassifiedCategory,
  isClassifiedExpired,
  localDateString,
} from "@/lib/classified-shared";
import type { Classified } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { RenewButton } from "@/components/marketplace/renew-button";

export async function generateMetadata() {
  const t = await getTranslations("marketplace");
  return { title: t("title") };
}

/** Translated price line: giveaway → "free", otherwise EUR + optional "VB". */
function priceLabel(ad: Classified, t: (key: string) => string, locale: string) {
  if (ad.category === "giveaway") return t("free");
  if (ad.price == null) return t("priceOnRequest");
  const formatted = ad.price.toLocaleString(locale, { style: "currency", currency: "EUR" });
  return ad.priceNegotiable ? `${formatted} ${t("negotiable")}` : formatted;
}

function thumbnailUrl(ad: Classified): string | null {
  const img = ad.images?.[0];
  if (!img) return null;
  return mediaUrl(img.formats?.small?.url ?? img.formats?.thumbnail?.url ?? img.url ?? null);
}

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const { category: rawCategory } = await searchParams;
  const category = rawCategory && isClassifiedCategory(rawCategory) ? rawCategory : undefined;

  const [t, tRel, locale, session] = await Promise.all([
    getTranslations("marketplace"),
    getTranslations("relativeTime"),
    getLocale(),
    auth(),
  ]);
  const relative = (d: string | undefined) => relativeTime(d, tRel);

  const userId = session?.user?.id;
  const canCreate = typeof userId === "number" && session?.user?.role !== "guest";
  const today = localDateString(new Date());

  const [listResult, mineResult] = await Promise.all([
    tryFetch(() => api.classifieds.list(today, category), "classifieds"),
    canCreate
      ? tryFetch(() => api.classifieds.mine(userId as number), "my-classifieds")
      : Promise.resolve({ data: null, failed: false }),
  ]);

  const ads = (listResult.data?.data ?? []) as Classified[];
  const myAds = (mineResult.data?.data ?? []) as Classified[];
  const anyFailed = listResult.failed || mineResult.failed;

  const newAdButton = (
    <Link
      href="/marketplace/new"
      className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Plus className="h-4 w-4" aria-hidden="true" />
      {t("newAd")}
    </Link>
  );

  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("description")}>
        {canCreate && newAdButton}
      </PageHeader>

      {anyFailed && <FetchErrorBanner />}

      {/* Category filter tabs (server-rendered links, ?category=…). */}
      <nav aria-label={t("categoryLabel")} className="flex flex-wrap gap-2">
        <CategoryTab href="/marketplace" active={!category} label={t("categoryAll")} />
        {AD_CATEGORIES.map((c) => (
          <CategoryTab
            key={c}
            href={`/marketplace?category=${c}`}
            active={category === c}
            label={t(AD_CATEGORY_KEYS[c] as Parameters<typeof t>[0])}
          />
        ))}
      </nav>

      {/* Own ads incl. expired ones — expired ads vanish from the public
          list automatically (expiresAt query filter), so this is the only
          place their owner still sees them, with a renew CTA. */}
      {myAds.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Tag className="h-3.5 w-3.5" aria-hidden="true" />
            {t("myAds")}
          </div>
          <div className="space-y-2">
            {myAds.map((ad) => {
              const expired = isClassifiedExpired(ad.expiresAt);
              return (
                <Card key={ad.id} className={expired ? "border-amber-500/40" : undefined}>
                  <CardContent className="flex flex-wrap items-center gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <Link href={`/marketplace/${ad.id}`} className="font-medium hover:underline">
                        {ad.title}
                      </Link>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        <span
                          className={cn(
                            "mr-2 inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
                            expired
                              ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                              : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                          )}
                        >
                          {expired ? t("statusExpired") : t("statusActive")}
                        </span>
                        {ad.expiresAt &&
                          (expired
                            ? t("expiredOn", {
                                date: new Date(ad.expiresAt).toLocaleDateString(locale),
                              })
                            : t("expiresOn", {
                                date: new Date(ad.expiresAt).toLocaleDateString(locale),
                              }))}
                      </div>
                      {expired && (
                        <p className="mt-1 text-xs text-muted-foreground">{t("expiredHint")}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {expired && <RenewButton id={ad.id} />}
                      <Link
                        href={`/marketplace/${ad.id}/edit`}
                        className="rounded-lg border px-3 py-1.5 text-xs font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      >
                        {t("editAd")}
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {ads.length === 0 ? (
        <EmptyState icon={ShoppingBag} title={t("emptyTitle")} hint={t("emptyHint")}>
          {canCreate && newAdButton}
        </EmptyState>
      ) : (
        <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ads.map((ad) => {
            const thumb = thumbnailUrl(ad);
            return (
              <Link key={ad.id} href={`/marketplace/${ad.id}`} className="focus-card group">
                <Card className="card-lift h-full overflow-hidden">
                  <div className="flex aspect-[4/3] items-center justify-center bg-muted/60">
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={thumb}
                        alt=""
                        className="h-full w-full object-cover transition group-hover:scale-[1.02]"
                      />
                    ) : (
                      <ImageIcon className="h-8 w-8 text-muted-foreground/60" aria-hidden="true" />
                    )}
                  </div>
                  <CardContent className="space-y-1.5 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <span className="line-clamp-2 font-medium">{ad.title}</span>
                    </div>
                    <div className="text-sm font-semibold text-primary">
                      {priceLabel(ad, t, locale)}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {ad.category && (
                        <span className="inline-flex rounded-full bg-muted px-2 py-0.5 font-medium">
                          {t(AD_CATEGORY_KEYS[ad.category] as Parameters<typeof t>[0])}
                        </span>
                      )}
                      {ad.location && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="h-3 w-3" aria-hidden="true" />
                          {ad.location}
                        </span>
                      )}
                      <span>{relative(ad.createdAt)}</span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CategoryTab({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-full border px-3 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );
}
