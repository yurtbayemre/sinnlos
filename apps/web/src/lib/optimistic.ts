/**
 * Pure helpers behind the optimistic UI of the comment section (FX28). No
 * React, so they are unit tested on their own (optimistic.test.ts).
 *
 * Reactions carry the DESIRED END STATE instead of "toggle":
 *   - React re-runs a pending optimistic update on every new base state. A
 *     refetch that lands while the click is still pending already contains
 *     the change; a toggle applied on top of it flipped the button back,
 *     the desired state leaves it as it is.
 *   - The same value goes to the CMS (`data.reacted`, comment-actions.ts),
 *     so a repeated request ends in the same state instead of undoing the
 *     first one. An older CMS ignores the key and toggles as before.
 *
 * Refetches are applied by a sequence guard that keeps the NEWEST snapshot
 * that arrived, not only the one requested last: a live ping can start a
 * refetch while a mutation's own refetch is in flight, and the former
 * `seq === latest` guard dropped the mutation's snapshot, so the UI rolled
 * back until the ping's answer came (or for good when that one failed).
 */
import type { EmojiType, ReactionSummary } from "@/lib/types";

/** What a click on one emoji asks for: the state the caller wants to end in. */
export interface ReactionIntent {
  emoji: EmojiType;
  reacted: boolean;
}

/** The intent of a click on `emoji`, given the summary the bar shows. */
export function reactionIntent(current: ReactionSummary[], emoji: EmojiType): ReactionIntent {
  const shown = current.find((r) => r.emoji === emoji);
  return { emoji, reacted: !(shown?.reacted ?? false) };
}

/**
 * The optimistic reducer: `current` with the caller's reaction set to the
 * intent. Idempotent: a summary that already has that state is returned
 * unchanged (same reference). Never mutates `current`.
 */
export function applyReactionIntent(
  current: ReactionSummary[],
  intent: ReactionIntent,
): ReactionSummary[] {
  const existing = current.find((r) => r.emoji === intent.emoji);
  if (!existing) {
    return intent.reacted
      ? [...current, { emoji: intent.emoji, count: 1, reacted: true }]
      : current;
  }
  if (existing.reacted === intent.reacted) return current;
  return current.map((r) =>
    r.emoji === intent.emoji
      ? {
          ...r,
          reacted: intent.reacted,
          count: Math.max(0, r.count + (intent.reacted ? 1 : -1)),
        }
      : r,
  );
}

/**
 * Orders overlapping refetches: `begin()` numbers each request, `commit()`
 * accepts an answer only when it is newer than the last one applied
 * (lastAppliedSeq). An older answer that arrives after a newer one was
 * applied is dropped; an answer is never dropped just because a newer
 * request is still in flight.
 */
export interface SeqGuard {
  begin(): number;
  commit(seq: number): boolean;
}

export function createSeqGuard(): SeqGuard {
  let lastIssuedSeq = 0;
  let lastAppliedSeq = 0;
  return {
    begin: () => ++lastIssuedSeq,
    commit: (seq) => {
      if (seq <= lastAppliedSeq) return false;
      lastAppliedSeq = seq;
      return true;
    },
  };
}

/**
 * Loads a snapshot and applies it when `guard` accepts it. Resolves true
 * when applied, false when a newer snapshot was already applied. A failed
 * load rejects without applying anything and without blocking any other
 * answer: the current state stays.
 */
export async function applyLatest<T>(
  guard: SeqGuard,
  load: () => Promise<T>,
  apply: (value: T) => void,
): Promise<boolean> {
  const seq = guard.begin();
  const value = await load();
  if (!guard.commit(seq)) return false;
  apply(value);
  return true;
}
