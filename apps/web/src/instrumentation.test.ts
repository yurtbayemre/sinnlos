import { afterEach, describe, expect, it, vi } from "vitest";

import { checkWebTimeZones, register, webZoneWarning } from "./instrumentation";
import { appTimeZone } from "./lib/app-time-zone";

/**
 * The web's start check of its zones (datetime contract, phase 2):
 * APP_TIME_ZONE with the same validation as the cms (plain-date.ts, from
 * @sinnlos/domain). The process zone decides nothing any more (every date is
 * rendered in APP_TIME_ZONE), so the container runs in UTC; another TZ only
 * warns. Run by Next.js's instrumentation hook at server start.
 */
describe("APP_TIME_ZONE in the web", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("defaults to Europe/Berlin and accepts IANA names", () => {
    expect(checkWebTimeZones({})).toBe("Europe/Berlin");
    expect(checkWebTimeZones({ APP_TIME_ZONE: "America/New_York" })).toBe("America/New_York");
    expect(checkWebTimeZones({ APP_TIME_ZONE: "europe/berlin" })).toBe("Europe/Berlin");
    vi.stubEnv("APP_TIME_ZONE", undefined);
    expect(appTimeZone()).toBe("Europe/Berlin");
    vi.stubEnv("APP_TIME_ZONE", "America/New_York");
    expect(appTimeZone()).toBe("America/New_York");
  });

  it("rejects an empty or unknown zone and a UTC offset", () => {
    expect(() => checkWebTimeZones({ APP_TIME_ZONE: "" })).toThrow(/APP_TIME_ZONE/);
    expect(() => checkWebTimeZones({ APP_TIME_ZONE: "Nowhere/Zone" })).toThrow(
      /IANA time zone name/,
    );
    // Intl accepts '+02:00'; Postgres would read it as UTC-2.
    expect(() => checkWebTimeZones({ APP_TIME_ZONE: "+02:00" })).toThrow(/not a UTC offset/);
  });

  it("accepts a UTC process with any APP_TIME_ZONE: the flip of datetime phase 2", () => {
    // Before phase 2 this combination refused to start (Node had to run IN APP_TIME_ZONE).
    const env = { APP_TIME_ZONE: "Europe/Berlin", TZ: "UTC" };
    expect(checkWebTimeZones(env)).toBe("Europe/Berlin");
    for (const zone of ["UTC", "Etc/UTC", "GMT"]) {
      expect(webZoneWarning(env, zone), zone).toBeNull();
    }
  });

  it("only warns when the container's TZ is not UTC; without TZ (next dev) it says nothing", () => {
    const legacy = { APP_TIME_ZONE: "Europe/Berlin", TZ: "Europe/Berlin" };
    expect(checkWebTimeZones(legacy)).toBe("Europe/Berlin");
    expect(webZoneWarning(legacy, "Europe/Berlin")).toMatch(
      /runs in Europe\/Berlin \(TZ="Europe\/Berlin"\), not UTC.*docker-compose\.web-legacy-tz\.yml/,
    );
    // TZ=europe/berlin: node:24-alpine does not know the lowercase name.
    expect(webZoneWarning({ TZ: "europe/berlin" }, undefined)).toMatch(/no zone Node recognises/);
    expect(webZoneWarning({ APP_TIME_ZONE: "Europe/Berlin" }, "Pacific/Auckland")).toBeNull();
    expect(webZoneWarning({ TZ: " " }, "Pacific/Auckland")).toBeNull();
  });

  it("register() checks this process and logs the zones", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("APP_TIME_ZONE", "America/New_York");
    expect(() => register()).not.toThrow();
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[datetime\] web process time zone .+, APP_TIME_ZONE America\/New_York$/,
      ),
    );
    vi.stubEnv("APP_TIME_ZONE", "Nowhere/Zone");
    expect(() => register()).toThrow(/IANA time zone name/);
  });
});
