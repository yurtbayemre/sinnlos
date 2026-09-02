"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { BarChart3, Clock, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { votePoll } from "@/lib/poll-actions";
import type { PollResults } from "@/lib/types";

export function PollCard({ results }: { results: PollResults }) {
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

  const isClosed = poll.closesAt ? new Date(poll.closesAt) < new Date() : false;
  const hasVoted = voted !== null;
  const showResults = hasVoted || isClosed;

  const handleVote = (index: number) => {
    if (hasVoted || isClosed || isPending) return;
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
        {isClosed && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {tPolls("closed")}
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {poll.options.map((option, i) => {
          const pct = localTotal > 0 ? Math.round((localCounts[i] / localTotal) * 100) : 0;
          const isMyVote = voted === i;
          return (
            <button
              key={i}
              type="button"
              onClick={() => handleVote(i)}
              disabled={hasVoted || isClosed || isPending}
              className={cn(
                "relative w-full overflow-hidden rounded-lg border px-4 py-2.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                !showResults && "hover:border-primary/40 hover:bg-muted",
                isPending && !showResults && "opacity-60",
                isMyVote && "border-primary/40",
                (hasVoted || isClosed) && "cursor-default",
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
