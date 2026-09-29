/**
 * Message keys (namespace `marketplace`) of the ad categories, typed
 * against the catalog (AC03): t(AD_CATEGORY_LABELS[category]) needs no cast,
 * and a key missing from messages/en.json is a type error. No server-only
 * import: the ad form is a client component.
 *
 * lib/classified-shared.ts still exports the untyped AD_CATEGORY_KEYS (the
 * ad detail page reads it); that module mirrors the cms's limits and moves
 * with the shared domain package (plan batch 12, lane 7B), so it is left
 * alone here.
 */
import type { Messages } from "next-intl";
import type { ClassifiedCategory } from "@/lib/types";

export const AD_CATEGORY_LABELS = {
  sale: "categorySale",
  giveaway: "categoryGiveaway",
  wanted: "categoryWanted",
  "service-offer": "categoryServiceOffer",
  "service-wanted": "categoryServiceWanted",
} as const satisfies Record<ClassifiedCategory, keyof Messages["marketplace"]>;
