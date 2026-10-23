import { describe, expect, it } from "vitest";

import {
  FEATURE_NAMES,
  FeaturesOffError,
  MODULE_NAMES,
  featuresOff,
  isSwitchedOff,
  parseFeaturesOff,
  searchKindEnabled,
} from "./features.js";
import { INDEXED_SEARCH_KINDS } from "./search.js";

/** FEATURES_OFF (v0.28): the one switch list of the cms and the web. */
describe("parseFeaturesOff", () => {
  it("is empty when unset or blank: everything on by default", () => {
    expect([...parseFeaturesOff(undefined)]).toEqual([]);
    expect([...parseFeaturesOff("")]).toEqual([]);
    expect([...parseFeaturesOff(" , ,")]).toEqual([]);
  });

  it("reads a comma list, trimmed and case-insensitive", () => {
    expect([...parseFeaturesOff(" Events ,polls,, KPIS ")].sort()).toEqual([
      "events",
      "kpis",
      "polls",
    ]);
  });

  it("accepts every module and feature name of the plan", () => {
    expect(MODULE_NAMES).toEqual([
      "events",
      "training",
      "marketplace",
      "kudos",
      "celebrations",
      "polls",
      "duty-plans",
      "kpis",
    ]);
    expect(FEATURE_NAMES).toEqual(["read-confirmations", "training-reports", "search-logging"]);
    const all = [...MODULE_NAMES, ...FEATURE_NAMES].join(",");
    expect(parseFeaturesOff(all).size).toBe(MODULE_NAMES.length + FEATURE_NAMES.length);
  });

  it("throws on an unknown name, naming it", () => {
    expect(() => parseFeaturesOff("events,evnts")).toThrow(FeaturesOffError);
    expect(() => parseFeaturesOff("events,evnts")).toThrow(/"evnts"/);
    // A base area is no switch.
    expect(() => parseFeaturesOff("wiki")).toThrow(FeaturesOffError);
  });

  it("switches training-reports off with training", () => {
    expect([...parseFeaturesOff("training")].sort()).toEqual(["training", "training-reports"]);
    expect([...parseFeaturesOff("training-reports")]).toEqual(["training-reports"]);
  });
});

describe("featuresOff / isSwitchedOff", () => {
  it("read FEATURES_OFF from an env", () => {
    const env = { FEATURES_OFF: "kudos,search-logging" };
    expect([...featuresOff(env)].sort()).toEqual(["kudos", "search-logging"]);
    expect(isSwitchedOff(env, "kudos")).toBe(true);
    expect(isSwitchedOff(env, "celebrations")).toBe(false);
    expect(isSwitchedOff({}, "kudos")).toBe(false);
  });
});

describe("searchKindEnabled", () => {
  it("drops the kinds of an off module and keeps the base kinds", () => {
    const off = parseFeaturesOff("events,polls");
    expect(INDEXED_SEARCH_KINDS.filter((kind) => searchKindEnabled(off, kind))).toEqual([
      "announcement",
      "wiki-page",
      "document",
    ]);
    expect(INDEXED_SEARCH_KINDS.every((kind) => searchKindEnabled(new Set(), kind))).toBe(true);
  });
});
