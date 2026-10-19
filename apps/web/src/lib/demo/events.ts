import type { Event, EventRsvp } from "@/lib/types";
import type { DemoClock } from "./clock";
import type { DemoUsers } from "./people";

export function demoEvents(users: DemoUsers, clock: DemoClock) {
  const events = [
    {
      id: 1,
      documentId: "demoevent000000000000001",
      title: "Summer team barbecue",
      description: "Rooftop terrace, vegetarian options included. Bring your +1!",
      start: clock.iso(3, 17),
      end: clock.iso(3, 21),
      rsvpEnabled: true,
      capacity: 40,
      location: "Rooftop, HQ",
      organizer: users.maria,
      departments: [],
      createdAt: clock.iso(-10),
    },
    {
      id: 2,
      documentId: "demoevent000000000000002",
      title: "Engineering demo day",
      description: "Platform, Web and Data show what shipped this quarter.",
      start: clock.iso(8, 14),
      end: clock.iso(8, 16),
      rsvpEnabled: false,
      location: "Auditorium + Teams",
      organizer: users.ada,
      departments: [{ id: 1, name: "Engineering", slug: "engineering" }],
      createdAt: clock.iso(-6),
    },
    {
      id: 3,
      documentId: "demoevent000000000000003",
      title: "Onboarding week welcome breakfast",
      description: "Meet the new joiners over coffee and croissants.",
      start: clock.iso(-4, 9),
      end: clock.iso(-4, 10),
      allDay: false,
      location: "Kitchen, 2nd floor",
      organizer: users.jonas,
      departments: [{ id: 2, name: "People & Culture", slug: "people-culture" }],
      createdAt: clock.iso(-15),
    },
  ] satisfies Event[];

  const eventRsvps: EventRsvp[] = [
    {
      id: 1,
      targetDocumentId: "demoevent000000000000001",
      status: "yes",
      respondedAt: clock.iso(-2),
      user: users.ada,
    },
    {
      id: 2,
      targetDocumentId: "demoevent000000000000001",
      status: "yes",
      respondedAt: clock.iso(-1),
      user: users.grace,
    },
    {
      id: 3,
      targetDocumentId: "demoevent000000000000001",
      status: "maybe",
      respondedAt: clock.iso(-1),
      user: users.linus,
    },
    {
      id: 4,
      targetDocumentId: "demoevent000000000000001",
      status: "no",
      respondedAt: clock.iso(-3),
      user: users.sofia,
    },
  ];

  return { events, eventRsvps };
}
