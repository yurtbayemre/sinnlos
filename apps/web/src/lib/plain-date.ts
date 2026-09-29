/**
 * Calendar dates and zone lookups with Intl only (datetime contract,
 * deep-dive decision 04, C5), from @sinnlos/domain (SH01,
 * packages/domain/src/plain-date.ts): one implementation for the cms and the
 * web, usable in server code and client components alike. Calendar dates
 * and day arithmetic of the web go through this module (ESLint enforces it,
 * see eslint.config.mjs).
 */
export {
  DEFAULT_APP_TIME_ZONE,
  addDaysToKey,
  canonicalTimeZone,
  daysBetweenKeys,
  formatPlainDate,
  instantEpochMs,
  isPlainDate,
  isValidTimeZone,
  isoWeekdayOfKey,
  resolveAppTimeZone,
  zonedDateKey,
  zonedDayStart,
  zonedHour,
  zonedWallTimeToInstant,
} from "@sinnlos/domain";
