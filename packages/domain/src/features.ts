/**
 * The module and feature switches (v0.28, S2 + M11): one env list,
 * `FEATURES_OFF`, read the same way by the cms and the web. Everything is on
 * by default; a name in the list switches that module or feature off. The
 * data of a switched-off module stays.
 *
 *   - Modules: everything outside the base (owner decision 2026-10-23). The
 *     base (dashboard, announcements, people and org, departments and teams,
 *     search, notifications and digest, profile, manage, quick links, wiki,
 *     documents) cannot be switched off.
 *   - Features: named personnel-data functions inside the base or a module.
 *     `training` off implies `training-reports` off.
 *
 * An unknown name throws: the cms refuses its boot, the web its start, so a
 * typo never leaves a module on that was meant to be off.
 */
import type { IndexedSearchKind } from "./search.js";

/** The modules a `FEATURES_OFF` entry can switch off. */
export const MODULE_NAMES = [
  "events",
  "training",
  "marketplace",
  "kudos",
  "celebrations",
  "polls",
  "duty-plans",
  "kpis",
] as const;

/** The features a `FEATURES_OFF` entry can switch off. */
export const FEATURE_NAMES = ["read-confirmations", "training-reports", "search-logging"] as const;

export type ModuleName = (typeof MODULE_NAMES)[number];
export type FeatureName = (typeof FEATURE_NAMES)[number];
export type SwitchName = ModuleName | FeatureName;

const SWITCH_NAMES: readonly string[] = [...MODULE_NAMES, ...FEATURE_NAMES];

/** What switching a name off switches off as well. */
const IMPLIED_OFF: Partial<Record<SwitchName, readonly SwitchName[]>> = {
  training: ["training-reports"],
};

/** The search kinds a module owns: off with the module. */
const SEARCH_KIND_MODULE: Partial<Record<IndexedSearchKind, ModuleName>> = {
  event: "events",
  poll: "polls",
};

export class FeaturesOffError extends Error {}

/**
 * The switched-off names of a `FEATURES_OFF` value: a comma list, trimmed,
 * case-insensitive, empty entries ignored, implied names added. Unset or
 * blank is the empty set. Throws FeaturesOffError on an unknown name.
 */
export function parseFeaturesOff(value: string | undefined): ReadonlySet<SwitchName> {
  const off = new Set<SwitchName>();
  for (const raw of (value ?? "").split(",")) {
    const name = raw.trim().toLowerCase();
    if (name === "") continue;
    if (!SWITCH_NAMES.includes(name)) {
      throw new FeaturesOffError(
        `FEATURES_OFF: unknown value "${raw.trim()}" (allowed: ${SWITCH_NAMES.join(", ")})`,
      );
    }
    off.add(name as SwitchName);
    for (const implied of IMPLIED_OFF[name as SwitchName] ?? []) off.add(implied);
  }
  return off;
}

/** The switched-off names of an env (`FEATURES_OFF`). */
export function featuresOff(env: Record<string, string | undefined>): ReadonlySet<SwitchName> {
  return parseFeaturesOff(env.FEATURES_OFF);
}

/** Whether `name` is switched off in this env. */
export function isSwitchedOff(env: Record<string, string | undefined>, name: SwitchName): boolean {
  return featuresOff(env).has(name);
}

/** Whether a search kind's module is on (the base kinds always are). */
export function searchKindEnabled(off: ReadonlySet<SwitchName>, kind: IndexedSearchKind): boolean {
  const owner = SEARCH_KIND_MODULE[kind];
  return owner === undefined || !off.has(owner);
}
