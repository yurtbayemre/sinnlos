import { describe, expect, it } from "vitest";

import { ICONS, isIconName } from "./icon-map";

/**
 * Quick-link icons are CMS-managed strings (quick-link.icon). isIconName is
 * the gate before ICONS[name] is rendered as a component (dashboard
 * quick-links.tsx), so it must accept the map's own keys only (FX27).
 */
describe("isIconName", () => {
  it("accepts every icon of the map", () => {
    for (const name of Object.keys(ICONS)) {
      expect(isIconName(name), name).toBe(true);
    }
  });

  it("rejects unknown names, other casing and empty values", () => {
    for (const name of ["Rocket", "calendar", "CALENDAR", " Calendar", "", null, undefined]) {
      expect(isIconName(name), String(name)).toBe(false);
    }
  });

  it("rejects inherited Object keys (a 'constructor' icon crashed the dashboard)", () => {
    for (const name of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
    ]) {
      expect(isIconName(name), name).toBe(false);
    }
  });
});
