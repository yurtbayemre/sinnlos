/**
 * Calendar dates and zone lookups with Intl only (datetime contract,
 * deep-dive decision 04, C5), from @sinnlos/domain (SH01,
 * packages/domain/src/plain-date.ts): one implementation for the cms and the
 * web, usable in server code and client components alike. Calendar dates
 * and day arithmetic of the web go through this module (ESLint enforces it,
 * see eslint.config.mjs). The authoring forms convert a typed date and time
 * in 'reject' mode (decision 06 §L4): a time a clock change repeats or skips
 * throws a WallTimeError instead of being guessed.
 */
export {
  DEFAULT_APP_TIME_ZONE,
  WallTimeError,
  addDaysToKey,
  canonicalTimeZone,
  daysBetweenKeys,
  formatPlainDate,
  instantEpochMs,
  isPlainDate,
  isValidTimeZone,
  isWallTimeError,
  isoWeekdayOfKey,
  resolveAppTimeZone,
  zonedDateKey,
  zonedDayStart,
  zonedHour,
  zonedTimeOfDay,
  zonedWallTimeToInstant,
  type WallTimeDisambiguation,
  type WallTimeErrorKind,
} from "@sinnlos/domain";
