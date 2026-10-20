import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { loadOpenAckCount } from "@/lib/loaders/announcements";

/**
 * Dashboard banner listing how many mandatory (requiresAck) announcements
 * and documents the current user has not confirmed yet
 * (lib/loaders/announcements.ts loadOpenAckCount: the rule of the open
 * section on /announcements and the buttons on /documents). Server
 * Component, per-user reads, uncached like every strapi() read (D-DC01).
 * Renders nothing when everything is confirmed or the reads failed (the
 * dashboard already shows its CMS-down banner). It links to /announcements
 * while announcements are open, else to /documents.
 */
export async function AckBanner() {
  const { count: openCount, documents: openDocuments } = await loadOpenAckCount();
  if (!openCount && !openDocuments) return null;

  const t = await getTranslations("dashboard");

  return (
    <Link
      href={openCount ? "/announcements" : "/documents"}
      className="focus-card flex items-center justify-between gap-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 transition-colors hover:border-amber-500/60"
    >
      <div className="flex items-center gap-3">
        <CheckCircle2
          className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
        <div>
          <div className="text-sm font-medium">{t("openAcksTitle")}</div>
          {!!openCount && (
            <div className="text-sm text-muted-foreground">
              {t("openAcksCount", { count: openCount })}
            </div>
          )}
          {!!openDocuments && (
            <div className="text-sm text-muted-foreground">
              {t("openAcksDocuments", { count: openDocuments })}
            </div>
          )}
        </div>
      </div>
      <span className="shrink-0 text-sm font-medium text-primary">{t("openAcksAction")}</span>
    </Link>
  );
}
