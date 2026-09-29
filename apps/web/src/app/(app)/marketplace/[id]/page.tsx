import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarClock, Mail, MapPin, Pencil, TriangleAlert } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { api } from "@/lib/strapi";
import { getViewer } from "@/lib/viewer";
import { mediaUrl } from "@/lib/config";
import { parseRowId } from "@/lib/entry-id";
import { tryFetch } from "@/lib/safe-fetch";
import { relativeTime } from "@/lib/relative-time";
import { appTimeZone } from "@/lib/app-time-zone";
import { AD_CATEGORY_LABELS } from "@/lib/classified-labels";
import { classifiedToday, formatAdExpiry, isClassifiedExpired } from "@/lib/classified-shared";
import { canDeleteAnyAd, canEditAnyAd } from "@/lib/roles";
import type { Classified } from "@/lib/types";
import { initials } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DeleteClassified } from "@/components/marketplace/delete-classified";
import { RenewButton } from "@/components/marketplace/renew-button";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params) {
  const { id } = await params;
  // A malformed id never reaches the CMS (WD07): Postgres answers the
  // filters[id] lookup with an error, i.e. a 500 instead of a 404.
  const rowId = parseRowId(id) ?? notFound();
  const [t, { data }] = await Promise.all([
    getTranslations("marketplace"),
    tryFetch(() => api.classifieds.one(String(rowId)), "classified-meta"),
  ]);
  const ad = data?.data?.[0] as Classified | undefined;
  return { title: ad?.title ?? t("title") };
}

/**
 * Detail-page error strategy (WD07, same on all detail pages): a malformed
 * or unknown id is a 404; a failed read goes to (app)/error.tsx, whose
 * "Try again" fetches the page again.
 */
export default async function ClassifiedDetailPage({ params }: Params) {
  const { id } = await params;
  const rowId = parseRowId(id) ?? notFound();
  // The ad read needs no role (the controls below are display-only), so it
  // runs alongside getViewer()'s /api/me read instead of behind it. The same
  // GET as generateMetadata's is sent once per render (Next's fetch dedupe).
  const [t, tRel, locale, session, viewer, res] = await Promise.all([
    getTranslations("marketplace"),
    getTranslations("relativeTime"),
    getLocale(),
    getSession(),
    getViewer(),
    api.classifieds.one(String(rowId)),
  ]);

  const ad = (res.data?.[0] ?? null) as Classified | null;
  if (!ad) notFound();

  const isOwner = typeof session?.user?.id === "number" && ad.author?.id === session.user.id;
  // The classified route policies (SH02, lib/roles.ts): editing is the
  // owner's and admin_role's (the update bypass); taking someone else's ad
  // down is a moderator's (the delete bypass: admin_role and editor). The
  // owner deletes on the edit page.
  const canEdit = isOwner || canEditAnyAd(viewer.role);
  const canTakeDown = !isOwner && canDeleteAnyAd(viewer.role);
  const timeZone = appTimeZone();
  const expired = isClassifiedExpired(ad.expiresAt, classifiedToday(timeZone));
  const images = (ad.images ?? [])
    .map((img) => {
      // Medium rendition preferred; carry its dimensions so the browser
      // reserves layout space (no CLS) — issue #30.
      const fmt = img.formats?.medium ?? img;
      return {
        id: img.id,
        url: mediaUrl(fmt.url ?? img.url ?? null),
        width: fmt.width,
        height: fmt.height,
      };
    })
    .filter((img): img is typeof img & { url: string } => !!img.url);

  const priceLine =
    ad.category === "giveaway"
      ? t("free")
      : ad.price == null
        ? t("priceOnRequest")
        : `${ad.price.toLocaleString(locale, { style: "currency", currency: "EUR" })}${
            ad.priceNegotiable ? ` ${t("negotiable")}` : ""
          }`;

  const authorName = ad.author?.displayName ?? ad.author?.email ?? "—";

  return (
    <div className="space-y-6">
      <Link
        href="/marketplace"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t("backToList")}
      </Link>

      {expired && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{t("expiredNotice")}</span>
          {isOwner && <RenewButton id={ad.id} />}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <header>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {ad.category && (
                <span className="inline-flex rounded-full bg-muted px-2 py-0.5 font-medium">
                  {t(AD_CATEGORY_LABELS[ad.category])}
                </span>
              )}
              <span>
                {t("postedOn", {
                  relative: relativeTime(ad.createdAt, tRel, { locale, timeZone }),
                })}
              </span>
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">{ad.title}</h1>
            <p className="mt-2 text-2xl font-semibold text-primary">{priceLine}</p>
          </header>

          {images.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {images.map((img, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={img.id}
                  src={img.url}
                  alt={`${ad.title} (${i + 1})`}
                  width={img.width}
                  height={img.height}
                  loading={i === 0 ? undefined : "lazy"}
                  className={
                    i === 0 && images.length > 1
                      ? "max-h-96 w-full rounded-2xl border object-cover sm:col-span-2"
                      : "max-h-96 w-full rounded-2xl border object-cover"
                  }
                />
              ))}
            </div>
          )}

          <Card>
            <CardContent className="p-4 sm:p-6">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{ad.description}</p>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
            {ad.location && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-4 w-4" aria-hidden="true" />
                {ad.location}
              </span>
            )}
            {ad.expiresAt && (
              <span className="inline-flex items-center gap-1.5">
                <CalendarClock className="h-4 w-4" aria-hidden="true" />
                {expired
                  ? t("expiredOn", { date: formatAdExpiry(ad.expiresAt, locale) })
                  : t("expiresOn", { date: formatAdExpiry(ad.expiresAt, locale) })}
              </span>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("sellerTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarFallback>{initials(authorName)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  {ad.author ? (
                    <Link
                      href={`/people/${ad.author.id}`}
                      className="truncate font-medium hover:underline"
                    >
                      {authorName}
                    </Link>
                  ) : (
                    <span className="truncate font-medium">{authorName}</span>
                  )}
                  {ad.author?.jobTitle && (
                    <div className="truncate text-xs text-muted-foreground">
                      {ad.author.jobTitle}
                    </div>
                  )}
                </div>
              </div>
              {/* Contact deliberately via company mail — no chat, no comments. */}
              {ad.author?.email && (
                <a
                  href={`mailto:${ad.author.email}?subject=${encodeURIComponent(
                    t("mailSubject", { title: ad.title }),
                  )}`}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <Mail className="h-4 w-4" aria-hidden="true" />
                  {t("contact")}
                </a>
              )}
            </CardContent>
          </Card>

          {canEdit && (
            <Link
              href={`/marketplace/${ad.id}/edit`}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
              {t("editAd")}
            </Link>
          )}

          {canTakeDown && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("moderationTitle")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">{t("moderationHint")}</p>
                <DeleteClassified id={ad.id} title={ad.title} />
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
