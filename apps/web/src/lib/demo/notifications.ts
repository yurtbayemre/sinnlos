import type { Notification } from "@/lib/types";
import type { DemoClock } from "./clock";
import type { DemoUsers } from "./people";

/**
 * The demo user's notifications (the bell reads them by recipient). Each
 * stores its values (`titleParams`, AC04) next to the English title, so the
 * bell shows them in the reader's language like a real row.
 */
export function demoNotifications(users: DemoUsers, clock: DemoClock) {
  const notifications: Notification[] = [
    {
      id: 1,
      type: "comment",
      title: 'Grace Hopper commented on "Q2 All-hands this Friday"',
      titleParams: { actor: "Grace Hopper", subject: "Q2 All-hands this Friday" },
      link: "/announcements",
      readAt: null,
      createdAt: clock.ago(0),
      actor: users.grace,
      recipient: users.ada,
    },
    {
      id: 2,
      type: "kudos",
      title: "Sofia Martín gave you kudos!",
      titleParams: { actor: "Sofia Martín" },
      link: "/kudos",
      readAt: null,
      createdAt: clock.iso(-1),
      actor: users.sofia,
      recipient: users.ada,
    },
    {
      id: 3,
      type: "announcement",
      title: "New announcement: Engineering handbook v2 published",
      titleParams: { subject: "Engineering handbook v2 published" },
      link: "/announcements",
      readAt: clock.iso(-2),
      createdAt: clock.iso(-2),
      actor: users.linus,
      recipient: users.ada,
    },
  ];

  return { notifications };
}
