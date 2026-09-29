/**
 * Marketplace constants shared between the (client) ad form and the
 * server actions. Lives outside classified-actions.ts because a
 * "use server" module may only export async functions.
 *
 * The limits are the CMS's own numbers, from @sinnlos/domain (SH01,
 * packages/domain/src/classified.ts; the classified controller and the
 * upload extension enforce them): the client checks are UX only, the CMS is
 * authoritative.
 */
import {
  CLASSIFIED_DEFAULT_LIFETIME_DAYS,
  CLASSIFIED_IMAGE_TYPES,
  CLASSIFIED_MAX_IMAGES,
  CLASSIFIED_MAX_IMAGE_BYTES,
  CLASSIFIED_MAX_IMAGE_MB,
} from "@sinnlos/domain";

import { addDaysToKey, formatPlainDate, isPlainDate, zonedDateKey } from "@/lib/plain-date";
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

export const MAX_AD_IMAGES = CLASSIFIED_MAX_IMAGES;
export const MAX_AD_IMAGE_MB = CLASSIFIED_MAX_IMAGE_MB;
export const MAX_AD_IMAGE_BYTES = CLASSIFIED_MAX_IMAGE_BYTES;
/** Client-declared types; the CMS re-verifies via magic bytes. */
export const AD_IMAGE_TYPES: string[] = [...CLASSIFIED_IMAGE_TYPES];

/**
 * Selectable ad lifetimes; the CMS clamps to [today, +90]
 * (CLASSIFIED_MAX_LIFETIME_DAYS) regardless.
 */
export const AD_DURATION_DAYS = [7, 14, 30, 60, 90];
export const AD_DEFAULT_DURATION_DAYS = CLASSIFIED_DEFAULT_LIFETIME_DAYS;

export function isClassifiedCategory(value: string): value is ClassifiedCategory {
  return (AD_CATEGORIES as string[]).includes(value);
}

/*
 * An ad's expiresAt is a calendar date ('YYYY-MM-DD', Strapi `date`) and
 * "today" is the day in APP_TIME_ZONE (datetime contract, decision 04, C3):
 * at 23:30Z on 30 Sep it is already 1 Oct in Berlin. This module is shared
 * with the client form, which cannot read APP_TIME_ZONE, so the server
 * passes the zone (lib/app-time-zone.ts) or the day in.
 */

/** Today ('YYYY-MM-DD') in `timeZone`, normally APP_TIME_ZONE. */
export function classifiedToday(timeZone: string, now: Date = new Date()): string {
  return zonedDateKey(now, timeZone);
}

/** The day `days` days after today in `timeZone`: an ad's expiresAt for that lifetime. */
export function dateInDays(days: number, timeZone: string, now: Date = new Date()): string {
  return addDaysToKey(classifiedToday(timeZone, now), days);
}

/**
 * Expired iff expiresAt < today (C7): an ad expiring today is still active
 * for the rest of that day. `today` is classifiedToday(APP_TIME_ZONE). A
 * value that is no calendar date never counts as expired.
 */
export function isClassifiedExpired(expiresAt: string | undefined, today: string): boolean {
  if (!expiresAt || !isPlainDate(expiresAt)) return false;
  return expiresAt < today;
}

/**
 * An ad's expiry day for display: formatted as the calendar date it is
 * (never through a midnight instant, which a zone west of UTC would show as
 * the day before), in the locale's numeric form as before. A value that is
 * no calendar date is shown as it is.
 */
export function formatAdExpiry(expiresAt: string, locale: string): string {
  return isPlainDate(expiresAt)
    ? formatPlainDate(locale, expiresAt, { year: "numeric", month: "numeric", day: "numeric" })
    : expiresAt;
}
