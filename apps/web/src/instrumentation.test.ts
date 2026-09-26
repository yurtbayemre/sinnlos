import { afterEach, describe, expect, it } from "vitest";

import { register } from "./instrumentation";
import { appTimeZone } from "./lib/app-time-zone";

/**
 * The web's start check of APP_TIME_ZONE (datetime contract): the same
 * validation as the cms (plain-date.ts is mirrored), run by Next.js's
 * instrumentation hook at server start.
 */
describe("APP_TIME_ZONE in the web", () => {
  const previous = process.env.APP_TIME_ZONE;

  afterEach(() => {
    if (previous === undefined) delete process.env.APP_TIME_ZONE;
    else process.env.APP_TIME_ZONE = previous;
  });

  it("defaults to Europe/Berlin and accepts IANA names", () => {
    delete process.env.APP_TIME_ZONE;
    expect(() => register()).not.toThrow();
    expect(appTimeZone()).toBe("Europe/Berlin");
    process.env.APP_TIME_ZONE = "America/New_York";
    expect(() => register()).not.toThrow();
    expect(appTimeZone()).toBe("America/New_York");
  });

  it("rejects an empty or unknown zone at server start", () => {
    process.env.APP_TIME_ZONE = "";
    expect(() => register()).toThrow(/APP_TIME_ZONE/);
    process.env.APP_TIME_ZONE = "Nowhere/Zone";
    expect(() => register()).toThrow(/IANA time zone name/);
  });
});
