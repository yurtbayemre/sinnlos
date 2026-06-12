"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { BarChart3, Clock, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { votePoll } from "@/lib/poll-actions";
import type { PollResults } from "@/lib/types";

export function PollCard({ results }: { results: PollResults }) {
  const tPolls = useTranslations("polls");
  const tCommon = useTranslations("common");
  const { poll, counts, total, myVoteIndex: initialVote } = results;
  const [voted, setVoted] = useState(initialVote);
  const [localCounts, setLocalCounts] = useState(counts);
  const [localTotal, setLocalTotal] = useState(total);
  const [isPending, startTransition] = useTransition();

  const isClosed = poll.closesAt ? new Date(poll.closesAt) < new Date() : false;
  const hasVoted = voted !== null;
  const showResults = hasVoted || isClosed;

  const handleVote = (index: number) => {
    if (hasVoted || isClosed || isPending) return;
    startTransition(async () => {
      try {
        await votePoll(poll.id, index);
        setVoted(index);
        setLocalCounts((prev) => prev.map((c, i) => (i === index ? c + 1 : c)));
        setLocalTotal((prev) => prev + 1);
      } catch {
        // vote failed — user may have already voted
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
                "relative w-full overflow-hidden rounded-lg border px-4 py-2.5 text-left text-sm transition",
                !showResults && "hover:border-primary/40 hover:bg-muted",
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
                {showResults && (
                  <span className="text-xs text-muted-foreground">{pct}%</span>
                )}
              </div>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}
