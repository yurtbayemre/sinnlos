import { afterEach, describe, expect, it, vi } from "vitest";
import { addDaysToKey, isPlainDate, zonedDateKey, zonedHour } from "./plain-date";

/**
 * DEMO_MODE fixture dates (datetime contract, phase 2): times of day are
 * wall times of APP_TIME_ZONE and calendar fields are calendar dates, in
 * whatever zone the process runs (`pnpm test:tz`). The fixtures are built
 * at import, so each case imports demo.ts afresh under its zone.
 */
type Row = Record<string, unknown>;
const rows = (body: unknown) => (body as { data: Row[] }).data;

async function loadDemo(zone: string) {
  vi.resetModules();
  vi.stubEnv("APP_TIME_ZONE", zone);
  return (await import("./demo")).demo;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(["Europe/Berlin", "America/New_York", "Pacific/Auckland"])(
  "demo fixtures in %s",
  (zone) => {
    it("start events on the hour in APP_TIME_ZONE", async () => {
      const demo = await loadDemo(zone);
      const events = rows(demo("/api/events"));
      expect(events.length).toBeGreaterThan(0);
      const hours = new Map(events.map((e) => [e.title, zonedHour(String(e.start), zone)]));
      expect(hours.get("Summer team barbecue")).toBe(17);
      expect(hours.get("Engineering demo day")).toBe(14);
      for (const e of events) {
        expect(new Date(String(e.start)).getUTCMinutes() % 15, String(e.title)).toBe(0);
      }
    });

    it("give calendar fields calendar dates relative to today there", async () => {
      const demo = await loadDemo(zone);
      const today = zonedDateKey(new Date(), zone);
      const [ack] = rows(demo("/api/announcements?filters[requiresAck][$eq]=true"));
      expect(ack?.ackDeadline).toBe(addDaysToKey(today, 7));
      for (const ad of rows(demo("/api/classifieds"))) {
        expect(isPlainDate(ad.expiresAt), String(ad.expiresAt)).toBe(true);
        expect(String(ad.expiresAt) > today).toBe(true);
      }
      const [birthday] = rows(demo("/api/celebrations"));
      expect(birthday?.date).toBe(addDaysToKey(today, 2));
    });
  },
);
