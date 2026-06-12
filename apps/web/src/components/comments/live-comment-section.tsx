"use client";

import { useCallback, useEffect, useState } from "react";
import { getCommentSection } from "@/lib/comment-actions";
import type { CommentSectionData } from "@/lib/reaction-summary";
import { CommentThread } from "./comment-thread";
import { ReactionBar } from "@/components/reactions/reaction-bar";

/**
 * Client wrapper that owns the comment + reaction data for one target and
 * keeps it fresh without reloading the page:
 *  - refetches right after own mutations (comment, delete, reaction), and
 *  - polls while the tab is visible, so changes made by OTHER sessions
 *    show up on their own.
 * Only this component's data reloads — the rest of the page is untouched.
 */
const POLL_MS = 10_000;

export function LiveCommentSection({
  targetType,
  targetId,
  currentUserId,
  initial,
}: {
  targetType: "announcement" | "wiki-page";
  targetId: number;
  currentUserId?: number;
  initial: CommentSectionData;
}) {
  const [data, setData] = useState(initial);

  const refetch = useCallback(async () => {
    try {
      setData(await getCommentSection(targetType, targetId));
    } catch {
      // Transient fetch errors just mean we keep showing the current state
      // until the next poll.
    }
  }, [targetType, targetId]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    const id = setInterval(tick, POLL_MS);
    // Refetch immediately when the tab regains focus — typical phone flow:
    // switch app, come back, expect current data.
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refetch]);

  return (
    <div className="space-y-4">
      <ReactionBar
        targetType={targetType}
        targetId={targetId}
        reactions={data.reactions}
        onChanged={refetch}
      />
      <CommentThread
        targetType={targetType}
        targetId={targetId}
        comments={data.comments}
        currentUserId={currentUserId}
        onChanged={refetch}
      />
    </div>
  );
}
