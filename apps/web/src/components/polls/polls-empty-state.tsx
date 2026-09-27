"use client";

import { BarChart3 } from "lucide-react";
import { useTranslations } from "next-intl";
import { EmptyState } from "@/components/empty-state";
import { isGuest } from "@/lib/roles";

/**
 * The /polls empty state. Polls are hidden from guests unless an admin or
 * editor opens them (owner decision 2026-09-27), so an empty list is the
 * normal case for a guest and does not mean there are no polls; the
 * "create polls in the admin panel" hint is not theirs to act on either.
 * A guest gets wording of their own, which says nothing about polls they
 * cannot see (no existence oracle). `viewerRole` picks wording only
 * (lib/roles.ts isGuest, exact `guest`).
 */
export function PollsEmptyState({ viewerRole }: { viewerRole?: string | null }) {
  const t = useTranslations("polls");
  const guest = isGuest(viewerRole);
  return (
    <EmptyState
      icon={BarChart3}
      title={t(guest ? "emptyTitleGuest" : "emptyTitle")}
      hint={t(guest ? "emptyHintGuest" : "emptyHint")}
    />
  );
}
