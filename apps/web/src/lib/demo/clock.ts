import { addDaysToKey, zonedDateKey, zonedWallTimeToInstant } from "@/lib/plain-date";

/**
 * Fixture dates relative to the demo day in APP_TIME_ZONE (datetime
 * contract, phase 2): iso(3, 17) is 17:00 there three days from now,
 * whatever zone the process runs in, and dateOnly(n) is a calendar date.
 */
export interface DemoClock {
  /** The demo day in APP_TIME_ZONE (YYYY-MM-DD). */
  readonly today: string;
  /** `hour`:00 in APP_TIME_ZONE, `offsetDays` from today, as an ISO instant. */
  iso(offsetDays: number, hour?: number): string;
  /** The calendar date `offsetDays` from today. */
  dateOnly(offsetDays: number): string;
  /** `days` × 24 h before the data set was built, as an ISO instant. */
  ago(days: number): string;
}

export function demoClock(zone: string, now: Date = new Date()): DemoClock {
  const today = zonedDateKey(now, zone);
  return {
    today,
    iso: (offsetDays, hour = 10) =>
      zonedWallTimeToInstant(
        addDaysToKey(today, offsetDays),
        `${String(hour).padStart(2, "0")}:00`,
        zone,
      ).toISOString(),
    dateOnly: (offsetDays) => addDaysToKey(today, offsetDays),
    ago: (days) => new Date(now.getTime() - days * 86_400_000).toISOString(),
  };
}
