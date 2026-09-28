"use client";

import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getCommentSection, getCommentSections } from "@/lib/comment-actions";
import type { CommentTarget } from "@/lib/comment-target";
import { channelFor, type ContentChannel } from "@/lib/live-contract";
import { applyLatest, createSeqGuard, type SeqGuard } from "@/lib/optimistic";
import type { CommentSectionData } from "@/lib/reaction-summary";
import { useLiveRegistry } from "@/components/live/live-events-provider";
import { CommentThread } from "./comment-thread";
import { ReactionBar } from "@/components/reactions/reaction-bar";

/**
 * Comment + reaction sections that stay fresh without reloading the page.
 *
 * One page-level owner, CommentSectionsProvider (WD04), keeps every section
 * of a page current:
 *   - ONE poll interval for all of them: 60s while the push stream is
 *     healthy (belt and braces against lost pings), today's 10s when it is
 *     degraded — with a dead stream this IS the pre-SSE system (issue #17
 *     fallback);
 *   - ONE subscription set: one live listener per target channel,
 *     registered with the LiveEventsProvider (which syncs them in one
 *     request); a ping refetches only the pinged targets;
 *   - each refetch is one batched getCommentSections call for every target
 *     that is due (one reactions request per 50 targets), instead of two
 *     requests per section, and so one entry in the Server Action queue
 *     instead of one per section.
 * No visibilitychange refetch per section any more: regaining the tab
 * reopens the stream, whose hello runs the provider's catch-up for every
 * channel (one batch), and when the stream cannot open the next poll tick
 * covers. With live events off (LIVE_EVENTS_DISABLED=1, DEMO_MODE, or no
 * LiveEventsProvider) there is no stream and no hello, so the page-level
 * owner refetches every section on regain itself, in one batch
 * (refreshOnTabRegain).
 *
 * Each section still refetches itself right after its own mutations
 * (comment, delete, reaction), and every snapshot, batched or its own, goes
 * through the section's sequence guard (FX28, lib/optimistic.ts): an older
 * snapshot never overwrites a newer one. Only the sections reload; the rest
 * of the page is untouched.
 *
 * A LiveCommentSection outside a provider gets one of its own.
 */
const POLL_MS_DEGRADED = 10_000;
const POLL_MS_HEALTHY = 60_000;
/** Pings of several targets that arrive together are fetched together. */
const BATCH_DELAY_MS = 50;
/** Targets per getCommentSections call (the action refuses more than 200). */
const MAX_TARGETS_PER_LOAD = 200;

/** One mounted section as the refresher sees it. */
export interface SectionHandle {
  target: CommentTarget;
  guard: SeqGuard;
  apply: (data: CommentSectionData) => void;
}

export interface SectionsRefresher {
  /** Adds a section on `channel`; true when it is the channel's first. */
  add(channel: ContentChannel, section: SectionHandle): boolean;
  /** Removes a section; true when the channel has none left. */
  remove(channel: ContentChannel, section: SectionHandle): boolean;
  /** Refetches these channels' sections (unknown channels are ignored). */
  refresh(channels: Iterable<ContentChannel>): void;
  /** Refetches every section. */
  refreshAll(): void;
  /** Drops a pending batch (unmount); refresh() starts again. */
  stop(): void;
}

/**
 * The page-level refetch queue: channels due for a refetch are collected
 * for BATCH_DELAY_MS and loaded with one `load` call (at most
 * MAX_TARGETS_PER_LOAD targets each), single-flight: channels that come due
 * while a batch runs go into the next one. Every section on a channel gets
 * the channel's snapshot through its own sequence guard. A channel whose
 * sections all unmounted while an earlier chunk loaded is left out of its
 * chunk. A failed load keeps the current state; the next ping or tick
 * retries. Pure (no React), so it is unit tested on its own.
 */
export function createSectionsRefresher(
  load: (targets: CommentTarget[]) => Promise<CommentSectionData[]>,
  delayMs = BATCH_DELAY_MS,
): SectionsRefresher {
  const sections = new Map<ContentChannel, Set<SectionHandle>>();
  const pending = new Set<ContentChannel>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight = false;

  const arm = () => {
    if (timer || inflight || pending.size === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  };

  async function flush(): Promise<void> {
    const channels = [...pending].filter((channel) => sections.has(channel));
    pending.clear();
    if (channels.length === 0) return;
    inflight = true;
    try {
      for (let i = 0; i < channels.length; i += MAX_TARGETS_PER_LOAD) {
        // A channel whose last section unmounted while an earlier chunk
        // loaded is gone (remove); leave it out, so its empty handle list
        // cannot fail the whole chunk. Handles, sequence numbers and
        // targets all come from `live`, so their indices stay aligned.
        const live = channels
          .slice(i, i + MAX_TARGETS_PER_LOAD)
          .filter((channel) => sections.has(channel));
        if (live.length === 0) continue;
        const handles = live.map((channel) => [...(sections.get(channel) ?? [])]);
        const begun = handles.map((list) =>
          list.map((section) => ({ section, seq: section.guard.begin() })),
        );
        let fresh: CommentSectionData[];
        try {
          fresh = await load(handles.map((list) => list[0]!.target));
        } catch {
          // Keep showing the current state; the next ping or tick retries.
          continue;
        }
        begun.forEach((list, j) => {
          const data = fresh[j];
          if (!data) return;
          for (const { section, seq } of list) {
            if (section.guard.commit(seq)) section.apply(data);
          }
        });
      }
    } finally {
      inflight = false;
      arm();
    }
  }

  const refresh = (channels: Iterable<ContentChannel>) => {
    for (const channel of channels) if (sections.has(channel)) pending.add(channel);
    arm();
  };

  return {
    add(channel, section) {
      const existing = sections.get(channel);
      if (existing) {
        existing.add(section);
        return false;
      }
      sections.set(channel, new Set([section]));
      return true;
    },
    remove(channel, section) {
      const existing = sections.get(channel);
      if (!existing) return false;
      existing.delete(section);
      if (existing.size > 0) return false;
      sections.delete(channel);
      pending.delete(channel);
      return true;
    },
    refresh,
    refreshAll: () => refresh(sections.keys()),
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}

/** The slice of `document` refreshOnTabRegain uses (a fake in tests). */
export interface TabDocument {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Without a push stream (`streaming` false), refetches every section as
 * soon as the tab is visible again: `refreshAll` queues one batched load.
 * With a stream it does nothing, because the stream's hello already runs
 * that catch-up and a second one would fetch twice. Returns the removal.
 */
export function refreshOnTabRegain(
  doc: TabDocument,
  streaming: boolean,
  refreshAll: () => void,
): () => void {
  if (streaming) return () => {};
  const onVisibility = () => {
    if (doc.visibilityState === "visible") refreshAll();
  };
  doc.addEventListener("visibilitychange", onVisibility);
  return () => doc.removeEventListener("visibilitychange", onVisibility);
}

type CommentSectionsRegistry = {
  /** Registers a mounted section on its channel; returns its removal. */
  register: (channel: ContentChannel, section: SectionHandle) => () => void;
};

const CommentSectionsContext = createContext<CommentSectionsRegistry | null>(null);

/** The page-level owner of every comment section below it (WD04). */
export function CommentSectionsProvider({ children }: { children: React.ReactNode }) {
  const { register: registerChannel, healthy, streaming } = useLiveRegistry();
  const [refresher] = useState(() =>
    createSectionsRefresher((targets) => getCommentSections(targets)),
  );
  const liveListenersRef = useRef(new Map<ContentChannel, () => void>());

  useEffect(() => () => refresher.stop(), [refresher]);

  // The one poll backstop of the page.
  useEffect(() => {
    const id = setInterval(
      () => {
        if (document.visibilityState === "visible") refresher.refreshAll();
      },
      healthy ? POLL_MS_HEALTHY : POLL_MS_DEGRADED,
    );
    return () => clearInterval(id);
  }, [refresher, healthy]);

  // Tab regain with live events off: no hello catch-up, so refetch here.
  useEffect(
    () => refreshOnTabRegain(document, streaming, () => refresher.refreshAll()),
    [refresher, streaming],
  );

  const registry = useMemo<CommentSectionsRegistry>(
    () => ({
      register(channel, section) {
        if (refresher.add(channel, section)) {
          // One live listener per channel: a ping refetches that channel
          // only, batched with whatever else is due.
          liveListenersRef.current.set(
            channel,
            registerChannel(channel, () => refresher.refresh([channel])),
          );
        }
        return () => {
          if (!refresher.remove(channel, section)) return;
          liveListenersRef.current.get(channel)?.();
          liveListenersRef.current.delete(channel);
        };
      },
    }),
    [refresher, registerChannel],
  );

  return (
    <CommentSectionsContext.Provider value={registry}>{children}</CommentSectionsContext.Provider>
  );
}

type SectionProps = {
  target: CommentTarget;
  currentUserId?: number;
  initial: CommentSectionData;
};

/** One target's comments and reactions, kept fresh by the page's provider. */
export function LiveCommentSection(props: SectionProps) {
  const registry = useContext(CommentSectionsContext);
  const body = <CommentSectionBody {...props} />;
  return registry ? body : <CommentSectionsProvider>{body}</CommentSectionsProvider>;
}

function CommentSectionBody({ target, currentUserId, initial }: SectionProps) {
  const registry = useContext(CommentSectionsContext);
  const [data, setData] = useState(initial);

  // Rebuild the target from its primitives so the registration below does
  // not restart on every render just because the prop object is a new
  // reference.
  const { type, documentId } = target;
  const stableTarget = useMemo<CommentTarget>(() => ({ type, documentId }), [type, documentId]);

  // Overlapping refetches (a live ping during a mutation's own refetch) are
  // applied newest-first by lastAppliedSeq (FX28, lib/optimistic.ts): an
  // older snapshot never overwrites a newer one, and the mutation's
  // snapshot is no longer dropped just because a later request is in
  // flight. The page's batches use the same guard.
  const [guard] = useState(createSeqGuard);

  // Inside a transition: when the refetch runs within a mutation's action
  // (ReactionBar), the new base state and the end of the optimistic state
  // commit together, without a flash of the old state in between.
  const apply = useCallback(
    (fresh: CommentSectionData) => startTransition(() => setData(fresh)),
    [],
  );

  // The target's content channel (lib/live-contract.ts); a target without
  // a usable documentId has none and is neither pinged nor polled.
  const channel = channelFor({ targetType: type, targetDocumentId: documentId });
  useEffect(() => {
    if (!registry || !channel) return;
    return registry.register(channel, { target: stableTarget, guard, apply });
  }, [registry, channel, stableTarget, guard, apply]);

  // After this section's own mutations: this section alone, right away.
  const refetch = useCallback(async () => {
    try {
      await applyLatest(guard, () => getCommentSection(stableTarget), apply);
    } catch {
      // Transient fetch errors just mean we keep showing the current state
      // until the next refetch.
    }
  }, [guard, stableTarget, apply]);

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
