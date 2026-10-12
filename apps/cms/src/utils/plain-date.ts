/**
 * Calendar dates and zone lookups with Intl only (datetime contract,
 * deep-dive decision 04, C5), from @sinnlos/domain (SH01,
 * packages/domain/src/plain-date.ts): one implementation for the cms and the
 * web. The cms's Temporal module (time.ts) must agree with it
 * (time-parity.test.ts).
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
