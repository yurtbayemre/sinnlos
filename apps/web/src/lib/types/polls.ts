/** Polls and their per-caller results (WD01, split from lib/types.ts). */
import type { UserLite } from "./common";
import type { Department } from "./org";

export interface Poll {
  id: number;
  documentId?: string;
  question: string;
  options: string[];
  closesAt?: string | null;
  anonymous?: boolean;
  /**
   * Department targeting flag (decision 02). A poll is targeted when this
   * is "departments" OR it links a department; null = a row from before
   * the flag. The web decides nothing from it: the CMS filters the list
   * and answers `canVote` per poll in the results.
   */
  audience?: "all" | "departments" | null;
  departments?: Department[];
  /**
   * Guest access (owner decision 2026-09-27): guests see the poll only when
   * this is true, and vote only when `guestsCanVote` is true as well. NULL
   * = a row from before the fields = hidden. The CMS decides per caller.
   */
  visibleToGuests?: boolean | null;
  guestsCanVote?: boolean | null;
  author?: UserLite | null;
  createdAt?: string;
}

/** One targeted department of a poll, as the results endpoints name it. */
export interface PollAudienceDepartment {
  documentId: string;
  name: string;
}

export interface PollResults {
  poll: {
    id: number;
    question: string;
    options: string[];
    closesAt?: string | null;
    anonymous?: boolean;
    /** Stored guest access (strict booleans); absent from an older CMS. */
    visibleToGuests?: boolean;
    /** Counts only together with visibleToGuests. */
    guestsCanVote?: boolean;
  };
  counts: number[];
  total: number;
  /** The caller's own vote, also on anonymous polls. */
  myVoteIndex: number | null;
  /**
   * Whether the caller may vote: true for the poll's audience, false for
   * an admin/editor outside it (they see the poll and its results only)
   * and for a guest on a poll visible to guests without guest voting.
   * Absent from a CMS older than decision 02; read it as `!== false`.
   */
  canVote?: boolean;
  /** Targeting summary; absent from a CMS older than decision 02. */
  audience?: {
    targeted: boolean;
    departments: PollAudienceDepartment[];
  };
}
