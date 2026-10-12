/**
 * Message keys (namespace `marketplace`) of the ad categories, typed
 * against the catalog (AC03): t(AD_CATEGORY_LABELS[category]) needs no cast,
 * and a key missing from messages/en.json is a type error. No server-only
 * import: the ad form is a client component. The only map of these keys:
 * the untyped AD_CATEGORY_KEYS of lib/classified-shared.ts is gone since
 * the batch 12 merge, and the list page, the detail page and the form all
 * read this one.
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
