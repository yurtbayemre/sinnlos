import { afterEach, describe, expect, it } from "vitest";

import { checkWebTimeZones, register } from "./instrumentation";
import { appTimeZone } from "./lib/app-time-zone";

/**
 * The web's start check of its zones (datetime contract): APP_TIME_ZONE with
 * the same validation as the cms (plain-date.ts is mirrored), and, where the
 * container sets TZ, the zone Node really runs in. Run by Next.js's
 * instrumentation hook at server start.
 */
describe("APP_TIME_ZONE in the web", () => {
  const previous = process.env.APP_TIME_ZONE;

  afterEach(() => {
    if (previous === undefined) delete process.env.APP_TIME_ZONE;
    else process.env.APP_TIME_ZONE = previous;
  });

  it("defaults to Europe/Berlin and accepts IANA names", () => {
    expect(checkWebTimeZones({}, "UTC")).toBe("Europe/Berlin");
    expect(checkWebTimeZones({ APP_TIME_ZONE: "America/New_York" }, "UTC")).toBe("America/New_York");
    delete process.env.APP_TIME_ZONE;
    expect(appTimeZone()).toBe("Europe/Berlin");
    process.env.APP_TIME_ZONE = "America/New_York";
    expect(appTimeZone()).toBe("America/New_York");
  });

  it("rejects an empty or unknown zone and a UTC offset", () => {
    expect(() => checkWebTimeZones({ APP_TIME_ZONE: "" }, "UTC")).toThrow(/APP_TIME_ZONE/);
    expect(() => checkWebTimeZones({ APP_TIME_ZONE: "Nowhere/Zone" }, "UTC")).toThrow(/IANA time zone name/);
    // Intl accepts '+02:00'; Postgres would read it as UTC-2.
    expect(() => checkWebTimeZones({ APP_TIME_ZONE: "+02:00" }, "UTC")).toThrow(/not a UTC offset/);
  });

  it("with TZ set, requires Node to run in APP_TIME_ZONE", () => {
    const berlin = { APP_TIME_ZONE: "Europe/Berlin", TZ: "Europe/Berlin" };
    expect(checkWebTimeZones(berlin, "Europe/Berlin")).toBe("Europe/Berlin");
    // TZ=europe/berlin: Intl finds the name case-insensitively, node:24-alpine
    // does not (it reports no zone and runs in UTC).
    const lowercase = { APP_TIME_ZONE: "europe/berlin", TZ: "europe/berlin" };
    expect(() => checkWebTimeZones(lowercase, undefined)).toThrow(/no zone Node recognises.*Europe\/Berlin/);
    expect(() => checkWebTimeZones(lowercase, "UTC")).toThrow(/runs in UTC/);
    // Links that Node reports under their canonical name are the same zone.
    expect(checkWebTimeZones({ APP_TIME_ZONE: "Asia/Kolkata", TZ: "Asia/Kolkata" }, "Asia/Calcutta")).toBe(
      "Asia/Calcutta",
    );
    expect(checkWebTimeZones({ APP_TIME_ZONE: "US/Eastern", TZ: "US/Eastern" }, "America/New_York")).toBe(
      "America/New_York",
    );
    // Without TZ (local next dev) the machine zone is not compared.
    expect(checkWebTimeZones({ APP_TIME_ZONE: "Europe/Berlin" }, "Pacific/Auckland")).toBe("Europe/Berlin");
  });

  it("register() checks this process", () => {
    process.env.APP_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(() => register()).not.toThrow();
    process.env.APP_TIME_ZONE = "Nowhere/Zone";
    expect(() => register()).toThrow(/IANA time zone name/);
  });
});
