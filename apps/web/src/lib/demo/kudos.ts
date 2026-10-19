import type { Celebration, Kudos } from "@/lib/types";
import type { DemoClock } from "./clock";
import type { DemoUsers } from "./people";

export function demoKudos(users: DemoUsers, clock: DemoClock) {
  const kudosEntries: Kudos[] = [
    {
      id: 1,
      message: "For calmly steering the Sev2 last Tuesday to a fix before lunch.",
      value: "leadership",
      from: users.ada,
      to: users.grace,
      createdAt: clock.iso(-1),
    },
    {
      id: 2,
      message: "The new onboarding checklist is a thing of beauty — new joiners notice.",
      value: "excellence",
      from: users.grace,
      to: users.jonas,
      createdAt: clock.iso(-2),
    },
    {
      id: 3,
      message: "Jumped on the landing-page bug on a Friday evening. Above and beyond.",
      value: "teamwork",
      from: users.sofia,
      to: users.linus,
      createdAt: clock.iso(-4),
    },
    {
      id: 4,
      message: "Turned a vague idea into a working prototype in two days.",
      value: "innovation",
      from: users.maria,
      to: users.ada,
      createdAt: clock.iso(-6),
    },
  ];

  const celebrations = [
    { user: users.jonas, type: "birthday", date: clock.dateOnly(2), daysUntil: 2 },
    { user: users.grace, type: "work-anniversary", years: 3, daysUntil: 9 },
  ] satisfies Celebration[];

  return { kudosEntries, celebrations };
}
