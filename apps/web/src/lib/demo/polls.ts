import type { Poll, PollResults } from "@/lib/types";
import type { DemoClock } from "./clock";
import type { DemoUsers } from "./people";

export function demoPolls(users: DemoUsers, clock: DemoClock) {
  const polls = [
    {
      id: 1,
      documentId: "demopoll0000000000000001",
      question: "Where should the winter offsite happen?",
      options: ["Mountains (ski + sauna)", "City trip (Lisbon)", "Countryside retreat"],
      closesAt: clock.iso(5),
      anonymous: false,
      author: users.maria,
      audience: "all",
      departments: [],
      // Guest access (owner decision 2026-09-27): opened to guests, with voting.
      visibleToGuests: true,
      guestsCanVote: true,
      createdAt: clock.iso(-2),
    },
    {
      id: 2,
      documentId: "demopoll0000000000000002",
      question: "How useful was the new incident-response training?",
      options: ["Very useful", "Somewhat useful", "Not useful"],
      closesAt: clock.iso(-1),
      anonymous: true,
      author: users.grace,
      audience: "departments",
      departments: [
        { id: 1, documentId: "demodepartment0000000001", name: "Engineering", slug: "engineering" },
      ],
      // Hidden from guests (the default).
      visibleToGuests: false,
      guestsCanVote: false,
      createdAt: clock.iso(-9),
    },
  ] satisfies Poll[];

  /** The counts, the demo user's vote and the audience per poll. */
  const pollTallies: Record<string, Omit<PollResults, "poll">> = {
    demopoll0000000000000001: {
      counts: [9, 6, 4],
      total: 19,
      myVoteIndex: null,
      canVote: true,
      audience: { targeted: false, departments: [] },
    },
    demopoll0000000000000002: {
      counts: [14, 5, 1],
      total: 20,
      myVoteIndex: 0,
      // Targeted at the demo viewer's own department (DEMO_VIEWER, Engineering).
      canVote: true,
      audience: {
        targeted: true,
        departments: [{ documentId: "demodepartment0000000001", name: "Engineering" }],
      },
    },
  };

  return { polls, pollTallies };
}

type DemoPolls = ReturnType<typeof demoPolls>;

/** A poll by its address: documentId or row id (DA01). */
export const pollByRef = ({ polls }: DemoPolls, ref: string): Poll | undefined =>
  polls.find((p) => p.documentId === ref || String(p.id) === ref);

/** The results body of a poll, as GET /api/polls/:id/results answers it. */
export function pollResultsOf({ pollTallies }: DemoPolls, poll: Poll): PollResults | null {
  const tally = poll.documentId ? pollTallies[poll.documentId] : undefined;
  if (!tally) return null;
  return {
    poll: {
      id: poll.id,
      documentId: poll.documentId,
      question: poll.question,
      options: poll.options,
      closesAt: poll.closesAt,
      anonymous: poll.anonymous ?? false,
      visibleToGuests: poll.visibleToGuests === true,
      guestsCanVote: poll.guestsCanVote === true,
    },
    ...tally,
    counts: [...tally.counts],
  };
}
