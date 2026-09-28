import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { api } from "@/lib/strapi";
import { computeOpenAcks, fetchMyAnnouncementAcks } from "@/lib/acknowledgements";
import { tryFetch } from "@/lib/safe-fetch";
import type { Acknowledgement, Announcement } from "@/lib/types";

/**
 * Dashboard banner listing how many mandatory (requiresAck) announcements
 * the current user has not confirmed yet. Server Component — both fetches
 * are per-user (the CMS announcement-visibility policy filters the list by
 * audience; the acks are the caller's own), like every strapi() read
 * uncached (D-DC01).
 * Renders nothing when everything is confirmed or a fetch fails (the
 * dashboard already shows a generic fetch-error banner).
 */
export async function AckBanner() {
  const [announcementsResult, acksResult] = await Promise.all([
    tryFetch(() => api.announcements.requiringAck(), "ack-banner"),
    tryFetch(() => fetchMyAnnouncementAcks(), "ack-banner"),
  ]);
  if (announcementsResult.failed || acksResult.failed) return null;

  // Same rule as the pinned "open confirmations" on /announcements
  // (computeOpenAcks: requiresAck re-checked, matched on documentId).
  const openCount = computeOpenAcks(
    (announcementsResult.data?.data ?? []) as Announcement[],
    (acksResult.data?.acks ?? []) as Acknowledgement[],
  ).length;
  if (openCount === 0) return null;

  const t = await getTranslations("dashboard");

  return (
    <Link
      href="/announcements"
      className="focus-card flex items-center justify-between gap-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 transition-colors hover:border-amber-500/60"
    >
      <div className="flex items-center gap-3">
        <CheckCircle2
          className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
        <div>
          <div className="text-sm font-medium">{t("openAcksTitle")}</div>
          <div className="text-sm text-muted-foreground">
            {t("openAcksCount", { count: openCount })}
          </div>
        </div>
      </div>
      <span className="shrink-0 text-sm font-medium text-primary">{t("openAcksAction")}</span>
    </Link>
  );
}
