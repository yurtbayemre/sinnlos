/**
 * Marketplace constants shared between the (client) ad form and the
 * server actions. Lives outside classified-actions.ts because a
 * "use server" module may only export async functions.
 *
 * The limits mirror the CMS enforcement (classified controller + upload
 * extension) — the client checks are UX only, the CMS is authoritative.
 */
import type { ClassifiedCategory } from "@/lib/types";

export const AD_CATEGORIES: ClassifiedCategory[] = [
  "sale",
  "giveaway",
  "wanted",
  "service-offer",
  "service-wanted",
];

/** i18n keys (marketplace namespace) per category. */
export const AD_CATEGORY_KEYS: Record<ClassifiedCategory, string> = {
  sale: "categorySale",
  giveaway: "categoryGiveaway",
  wanted: "categoryWanted",
  "service-offer": "categoryServiceOffer",
  "service-wanted": "categoryServiceWanted",
};

export const MAX_AD_IMAGES = 4;
export const MAX_AD_IMAGE_MB = 5;
export const MAX_AD_IMAGE_BYTES = MAX_AD_IMAGE_MB * 1024 * 1024;
/** Client-declared types; the CMS re-verifies via magic bytes. */
export const AD_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Selectable ad lifetimes; the CMS clamps to [today, +90] regardless. */
export const AD_DURATION_DAYS = [7, 14, 30, 60, 90];
export const AD_DEFAULT_DURATION_DAYS = 30;

export function isClassifiedCategory(value: string): value is ClassifiedCategory {
  return (AD_CATEGORIES as string[]).includes(value);
}

/** Local YYYY-MM-DD (toISOString would shift across the UTC boundary). */
export function localDateString(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

export function dateInDays(days: number): string {
  const now = new Date();
  return localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}

/** An ad expiring today is still active for the rest of the day. */
export function isClassifiedExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) return false;
  return expiresAt < localDateString(new Date());
}
