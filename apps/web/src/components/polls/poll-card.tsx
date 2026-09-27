"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { BarChart3, Clock, Check, Eye, Users, Vote } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { isPollClosed } from "@/lib/poll-close";
import { votePoll } from "@/lib/poll-actions";
import { pollAudienceView, pollGuestNotes } from "@/lib/poll-audience-view";
import { canCreatePolls, isGuest } from "@/lib/roles";
import type { PollResults } from "@/lib/types";

/**
 * `viewerRole` (getViewer().role) only shapes the wording: admins and
 * editors (canCreatePolls) get the guest-access notes, a guest gets the
 * guestVotingDisabled hint instead of notInAudience. Whether the caller may
 * vote comes from `results.canVote` alone.
 */
export function PollCard({
  results,
  viewerRole = null,
}: {
  results: PollResults;
  viewerRole?: string | null;
}) {
  const tPolls = useTranslations("polls");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const { poll } = results;
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Optimistic vote (issue #34): own vote and counts flip instantly, the
  // action's refresh() delivers the authoritative results prop within the
  // same transition, and a rejected vote rolls back automatically.
  const [optimistic, applyVote] = useOptimistic(results, (prev: PollResults, index: number) => ({
    ...prev,
    myVoteIndex: index,
    counts: prev.counts.map((c, i) => (i === index ? c + 1 : c)),
    total: prev.total + 1,
  }));
  const { counts: localCounts, total: localTotal, myVoteIndex: voted } = optimistic;

  // Department targeting (decision 02) and guest access (owner decision
  // 2026-09-27): the CMS says per poll whether this caller may vote; an
  // admin or editor outside the poll's departments, and a guest on a poll
  // without guest voting, see the results but no vote buttons.
  const { canVote, targeted, departmentNames, hint } = pollAudienceView(results, {
    viewerIsGuest: isGuest(viewerRole),
  });
  const guestNotes = canCreatePolls(viewerRole) ? pollGuestNotes(poll) : [];

  const isClosed = isPollClosed(poll.closesAt);
  const hasVoted = voted !== null;
  // Results show exactly when voting is over for this caller: voted,
  // closed, or not in the poll's audience.
  const showResults = hasVoted || isClosed || !canVote;

  const handleVote = (index: number) => {
    if (showResults || isPending) return;
    setError(null);
    startTransition(async () => {
      applyVote(index);
      try {
        await votePoll(poll.id, index);
      } catch {
        // Vote rejected (already voted, poll closed meanwhile, …) —
        // surface it and pull the authoritative counts from the server.
        setError(tPolls("voteFailed"));
        router.refresh();
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">{poll.question}</CardTitle>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />
            {tCommon("vote", { count: localTotal })}
          </div>
        </div>
        {(isClosed || (targeted && departmentNames.length > 0) || guestNotes.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {isClosed && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" aria-hidden="true" />
                {tPolls("closed")}
              </span>
            )}
            {targeted && departmentNames.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <Users className="h-3 w-3" aria-hidden="true" />
                {tPolls("audienceDepartments", { departments: departmentNames.join(", ") })}
              </span>
            )}
            {guestNotes.map((note) => (
              <span key={note} className="inline-flex items-center gap-1">
                {note === "guestAccessVisible" ? (
                  <Eye className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <Vote className="h-3 w-3" aria-hidden="true" />
                )}
                {tPolls(note)}
              </span>
            ))}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {hint && <p className="text-xs text-muted-foreground">{tPolls(hint)}</p>}
        {poll.options.map((option, i) => {
          const pct = localTotal > 0 ? Math.round((localCounts[i] / localTotal) * 100) : 0;
          const isMyVote = voted === i;
          return (
            <button
              key={i}
              type="button"
              onClick={() => handleVote(i)}
              disabled={showResults || isPending}
              className={cn(
                "relative w-full overflow-hidden rounded-lg border px-4 py-2.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                !showResults && "hover:border-primary/40 hover:bg-muted",
                isPending && !showResults && "opacity-60",
                isMyVote && "border-primary/40",
                showResults && "cursor-default",
              )}
            >
              {showResults && (
                <div
                  className={cn(
                    "absolute inset-y-0 left-0 transition-all duration-500",
                    isMyVote ? "bg-primary/15" : "bg-muted/60",
                  )}
                  style={{ width: `${pct}%` }}
                />
              )}
              <div className="relative flex items-center justify-between gap-2">
                <span className={cn("font-medium", isMyVote && "text-primary")}>
                  {isMyVote && <Check className="mr-1.5 inline h-3.5 w-3.5" />}
                  {option}
                </span>
                {showResults && <span className="text-xs text-muted-foreground">{pct}%</span>}
              </div>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}
