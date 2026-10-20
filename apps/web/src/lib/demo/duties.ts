import type { DutyPlan } from "@/lib/types";
import type { DemoClock } from "./clock";
import type { DemoUsers } from "./people";

/** Two published duty plans (v0.18): a week-long key service and three shifts a day. */
export function demoDuties(users: DemoUsers, clock: DemoClock) {
  const engineering = {
    id: 1,
    documentId: "demodepartment0000000001",
    name: "Engineering",
    slug: "engineering",
  };
  const shifts = (day: number) => [
    { userId: users.grace.id, startsAt: clock.iso(day, 6), endsAt: clock.iso(day, 14) },
    { userId: users.linus.id, startsAt: clock.iso(day, 14), endsAt: clock.iso(day, 22) },
    { userId: users.ada.id, startsAt: clock.iso(day, 22), endsAt: clock.iso(day + 1, 6) },
  ];
  const dutyPlans: DutyPlan[] = [
    {
      id: 1,
      documentId: "demodutyplan000000000001",
      name: "Schlüsseldienst",
      note: "Schlüssel im Fach 3",
      department: null,
      shiftTemplates: [],
      shifts: [{ userId: users.jonas.id, startsAt: clock.iso(-2, 6), endsAt: clock.iso(5, 6) }],
    },
    {
      id: 2,
      documentId: "demodutyplan000000000002",
      name: "Schichtleitung Halle 2",
      note: null,
      department: engineering,
      shiftTemplates: [
        { label: "Früh", start: "06:00", end: "14:00" },
        { label: "Spät", start: "14:00", end: "22:00" },
        { label: "Nacht", start: "22:00", end: "06:00" },
      ],
      shifts: [-1, 0, 1, 2, 3].flatMap(shifts),
    },
  ];
  return { dutyPlans };
}
