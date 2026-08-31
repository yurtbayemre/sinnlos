"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCommentSection } from "@/lib/comment-actions";
import type { CommentTarget } from "@/lib/comment-target";
import type { CommentSectionData } from "@/lib/reaction-summary";
import { useLiveChannel } from "@/components/live/live-events-provider";
import { CommentThread } from "./comment-thread";
import { ReactionBar } from "@/components/reactions/reaction-bar";

/**
 * Client wrapper that owns the comment + reaction data for one target and
 * keeps it fresh without reloading the page:
 *  - refetches right after own mutations (comment, delete, reaction),
 *  - refetches on live SSE pings for this target's channel, and
 *  - polls as a backstop: 60s while the push stream is healthy (belt and
 *    braces against lost pings), today's 10s when it is degraded — with a
 *    dead stream this component IS the pre-SSE system (issue #17 fallback).
 * Only this component's data reloads — the rest of the page is untouched.
 */
const POLL_MS_DEGRADED = 10_000;
const POLL_MS_HEALTHY = 60_000;

export function LiveCommentSection({
  target,
  currentUserId,
  initial,
}: {
  target: CommentTarget;
  currentUserId?: number;
  initial: CommentSectionData;
}) {
  const [data, setData] = useState(initial);

  // Rebuild the target from its primitives so the polling effect below does
  // not restart on every render just because the prop object is a new
  // reference.
  const { type, documentId } = target;
  const stableTarget = useMemo<CommentTarget>(() => ({ type, documentId }), [type, documentId]);

  // Monotonic request counter: a ping-triggered refetch can overlap the
  // post-mutation one, and applying an older snapshot out of order would
  // visibly roll back the user's own just-posted comment.
  const seqRef = useRef(0);

  const refetch = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const fresh = await getCommentSection(stableTarget);
      if (seq === seqRef.current) setData(fresh);
    } catch {
      // Transient fetch errors just mean we keep showing the current state
      // until the next poll.
    }
  }, [stableTarget]);

  const healthy = useLiveChannel(`${type}:${documentId}`, refetch);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    const id = setInterval(tick, healthy ? POLL_MS_HEALTHY : POLL_MS_DEGRADED);
    // Refetch immediately when the tab regains focus — typical phone flow:
    // switch app, come back, expect current data.
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refetch, healthy]);

  return (
    <div className="space-y-4">
      <ReactionBar target={stableTarget} reactions={data.reactions} onChanged={refetch} />
      <CommentThread
        target={stableTarget}
        comments={data.comments}
        currentUserId={currentUserId}
        onChanged={refetch}
      />
    </div>
  );
}
