"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Megaphone } from "lucide-react";
import { useTranslations } from "next-intl";

import { getVisibleAnnouncementDocumentIds } from "@/lib/announcement-live-actions";
import { useHydrated } from "@/lib/use-hydrated";
import { useLiveChannel } from "@/components/live/live-events-provider";

/**
 * Silent live check for the announcements list. The coarse
 * `announcements` ping reaches every connected user, including those a
 * restricted post is NOT for — so we never toast on the raw ping.
 * Instead we re-probe the caller's visible id set through the policy-
 * filtered action and only surface the hint when it actually gained an
 * id. Out-of-audience users see nothing at all; no phantom "news" toast
 * pointing at an unchanged list.
 *
 * Rendered via createPortal(document.body): the sticky topbar's
 * backdrop-filter and PageFade's retained transform both turn ancestors
 * into containing blocks for fixed descendants (repo rule: EVERY fixed
 * element below Topbar/PageFade gets portaled).
 */
export function AnnouncementsLiveHint({ initialIds }: { initialIds: string[] }) {
  const router = useRouter();
  const t = useTranslations("announcements");
  const hydrated = useHydrated();
  const [showHint, setShowHint] = useState(false);
  const [baseline, setBaseline] = useState(() => ({
    source: initialIds,
    ids: new Set(initialIds),
  }));

  // A server re-render (router.refresh, navigation) delivers the fresh
  // list — whatever it now shows is the new baseline. Adopted via the
  // compare-and-set-during-render pattern (issue #36) instead of an
  // effect, so the reset happens in the same render pass.
  if (baseline.source !== initialIds) {
    setBaseline({ source: initialIds, ids: new Set(initialIds) });
    setShowHint(false);
  }

  // Plain closure: useLiveChannel wraps it in an Effect Event, so the
  // latest render's baseline is always seen without memoisation.
  const check = async () => {
    const ids = await getVisibleAnnouncementDocumentIds();
    if (ids.length === 0) return; // probe failed or truly empty — no hint
    if (ids.some((id) => !baseline.ids.has(id))) setShowHint(true);
  };

  useLiveChannel("announcements", check);

  if (!hydrated || !showHint) return null;

  return createPortal(
    <div className="fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <button
        type="button"
        onClick={() => {
          setShowHint(false);
          router.refresh();
        }}
        className="flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <Megaphone className="h-4 w-4" aria-hidden />
        {t("liveNewHint")}
      </button>
    </div>,
    document.body,
  );
}
