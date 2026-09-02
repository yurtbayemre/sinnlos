import Link from "next/link";
import { GraduationCap } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { tryFetch } from "@/lib/safe-fetch";
import { fetchCourses, fetchMyProgress } from "@/lib/training";
import { courseCompletion } from "@/lib/training-shared";

/**
 * Dashboard banner counting the mandatory courses the current user has
 * not completed yet (ack-banner clone, issue #29). Server Component,
 * both fetches per-user ⇒ noCache. Renders nothing when everything is
 * done, nothing is assigned, or a fetch fails/truncates — fail-closed
 * means no banner rather than a wrong count.
 */
export async function TrainingBanner() {
  const [coursesResult, progressResult] = await Promise.all([
    tryFetch(() => fetchCourses(), "training-banner"),
    tryFetch(() => fetchMyProgress(), "training-banner"),
  ]);
  if (coursesResult.failed || progressResult.failed) return null;
  if (coursesResult.data!.truncated || progressResult.data!.truncated) return null;

  const completed = new Set(progressResult.data!.completed.keys());
  const openCount = coursesResult.data!.courses.filter((course) => {
    if (!course.mandatory) return false;
    const { total, done } = courseCompletion(course.lessons ?? [], completed);
    return total > 0 && !done;
  }).length;
  if (openCount === 0) return null;

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
          <div className="text-sm font-medium">{t("trainingOpen", { count: openCount })}</div>
          <div className="text-xs text-muted-foreground">{t("trainingOpenHint")}</div>
        </div>
      </div>
      <span className="text-xs text-muted-foreground">{t("trainingOpenCta")}</span>
    </Link>
  );
}
