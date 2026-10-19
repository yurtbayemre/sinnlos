import type { Acknowledgement, Announcement, Comment, Reaction } from "@/lib/types";
import type { DemoClock } from "./clock";
import type { DemoUsers } from "./people";

export function demoAnnouncements(users: DemoUsers, clock: DemoClock) {
  const announcements = [
    {
      id: 1,
      documentId: "demoann00000000000000001",
      title: "Q2 All-hands this Friday",
      requiresAck: true,
      // A calendar date, like the cms's `date` field.
      ackDeadline: clock.dateOnly(7),
      body: "Join us at 15:00 CET in the main auditorium or on Teams. Agenda: quarterly numbers, product roadmap, and a live demo of the new intranet.",
      pinned: true,
      createdAt: clock.ago(0),
      author: users.maria,
    },
    {
      id: 2,
      documentId: "demoann00000000000000002",
      title: "New wiki search is live",
      body: "Hit ⌘K anywhere in the app to fuzzy search wiki pages, people and teams. Special filters: `in:handbook`, `by:@grace`, `tag:runbook`.",
      pinned: true,
      createdAt: clock.ago(1),
      author: users.ada,
    },
    {
      id: 3,
      documentId: "demoann00000000000000003",
      title: "Office closed Mon 2026-05-01",
      body: "Public holiday. Remote work as usual. On-call rotation is unchanged — please check your PagerDuty schedule.",
      pinned: false,
      createdAt: clock.ago(2),
      author: users.jonas,
    },
    {
      id: 4,
      documentId: "demoann00000000000000004",
      title: "Welcome Sofia to Marketing",
      body: "Sofia Martín joins us this week as Head of Marketing, coming from a background in brand and growth at two previous startups.",
      pinned: false,
      createdAt: clock.ago(5),
      author: users.maria,
    },
    {
      id: 5,
      documentId: "demoann00000000000000005",
      title: "Infra maintenance window: Sat 02:00–04:00 CET",
      body: "Platform team will be upgrading Postgres and rotating TLS certificates. Expect brief blips on API calls during the window.",
      pinned: false,
      createdAt: clock.ago(7),
      author: users.grace,
    },
    {
      id: 6,
      documentId: "demoann00000000000000006",
      title: "Engineering handbook v2 published",
      body: "New sections on incident response, ADR workflow, and our updated code review checklist. Read it in the Wiki → Engineering space.",
      pinned: false,
      createdAt: clock.ago(10),
      author: users.linus,
    },
  ] satisfies Announcement[];

  const comments: Comment[] = [
    {
      id: 1,
      body: "Will the session be recorded for the folks on parental leave?",
      targetType: "announcement",
      targetDocumentId: "demoann00000000000000001",
      author: users.grace,
      createdAt: clock.iso(-1, 9),
    },
    {
      id: 2,
      body: "Yes — recording lands in the wiki right after. 🎥",
      targetType: "announcement",
      targetDocumentId: "demoann00000000000000001",
      author: users.maria,
      createdAt: clock.iso(-1, 11),
    },
    {
      id: 3,
      body: "The new search filters are a game changer, thanks team!",
      targetType: "announcement",
      targetDocumentId: "demoann00000000000000002",
      author: users.jonas,
      createdAt: clock.iso(0, 7),
    },
  ];

  const reactions: Reaction[] = [
    {
      id: 1,
      emoji: "celebrate",
      targetType: "announcement",
      targetDocumentId: "demoann00000000000000001",
      author: users.grace,
    },
    {
      id: 2,
      emoji: "thumbsup",
      targetType: "announcement",
      targetDocumentId: "demoann00000000000000001",
      author: users.linus,
    },
    {
      id: 3,
      emoji: "heart",
      targetType: "announcement",
      targetDocumentId: "demoann00000000000000004",
      author: users.ada,
    },
  ];

  const acknowledgements: Acknowledgement[] = [];

  return { announcements, comments, reactions, acknowledgements };
}
