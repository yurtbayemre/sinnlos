import type { Classified } from "@/lib/types";
import type { DemoClock } from "./clock";
import type { DemoUsers } from "./people";

export function demoMarketplace(users: DemoUsers, clock: DemoClock) {
  const classifieds: Classified[] = [
    {
      id: 1,
      documentId: "demoad000000000000000001",
      title: "City bike, 3 years old, well maintained",
      description: "Freshly serviced, new brake pads. Pickup near the office.",
      category: "sale",
      price: 180,
      priceNegotiable: true,
      location: "HQ / city center",
      images: null,
      expiresAt: clock.dateOnly(21),
      author: users.linus,
      createdAt: clock.iso(-3),
    },
    {
      id: 2,
      documentId: "demoad000000000000000002",
      title: "Moving boxes to give away",
      description: "About 15 sturdy boxes from a recent move. First come, first served.",
      category: "giveaway",
      price: null,
      location: "2nd floor storage",
      images: null,
      expiresAt: clock.dateOnly(10),
      author: users.jonas,
      createdAt: clock.iso(-1),
    },
    {
      id: 3,
      documentId: "demoad000000000000000003",
      title: "Looking for a German tandem partner",
      description: "Native Spanish speaker, B1 German — happy to trade lunch breaks.",
      category: "service-wanted",
      price: null,
      location: "Remote / office",
      images: null,
      expiresAt: clock.dateOnly(30),
      author: users.sofia,
      createdAt: clock.iso(-5),
    },
  ];

  return { classifieds };
}
