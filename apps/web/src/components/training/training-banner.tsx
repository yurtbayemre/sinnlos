import Link from "next/link";
import { GraduationCap } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { loadTrainingOverview } from "@/lib/loaders/training";

/**
 * Dashboard banner counting the mandatory courses the current user has
 * not completed yet (ack-banner clone, issue #29), from the same overview
 * as /training (lib/loaders/training.ts). Server Component, per-user reads
 * (uncached, D-DC01). Renders nothing when everything is done, nothing is
 * assigned, or a read failed or was cut short — fail-closed means no
 * banner rather than a wrong count.
 */
export async function TrainingBanner() {
  const { openMandatory: openCount, dueSoonMandatory: dueSoonCount } =
    await loadTrainingOverview("training-banner");
  if (!openCount && !dueSoonCount) return null;

  const t = await getTranslations("dashboard");

  return (
    <Link
      href="/training"
      className="focus-card flex items-center justify-between gap-4 rounded-xl border border-sky-500/40 bg-sky-500/10 px-4 py-3 transition-colors hover:border-sky-500/60"
    >
      <div className="flex items-center gap-3">
        <GraduationCap
          className="h-5 w-5 shrink-0 text-sky-600 dark:text-sky-400"
          aria-hidden="true"
        />
        <div>
          <div className="text-sm font-medium">
            {openCount
              ? t("trainingOpen", { count: openCount })
              : t("trainingDueSoon", { count: dueSoonCount ?? 0 })}
          </div>
          <div className="text-xs text-muted-foreground">
            {openCount ? t("trainingOpenHint") : t("trainingDueSoonHint")}
          </div>
        </div>
      </div>
      <span className="text-xs text-muted-foreground">{t("trainingOpenCta")}</span>
    </Link>
  );
}
