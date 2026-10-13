/**
 * The message catalog of one language (AC03, AC04; deep-dive decision 06
 * §L7): the app-wide `messages/<locale>.json` plus the /manage namespaces,
 * which live in their own files per area,
 * `messages/manage/<area>.<locale>.json`, merged under `manage.<area>`.
 * Why separate files: the lanes of batches 16 and 17 each own their area
 * files (documents, wiki, training, org, activity), so en.json and de.json
 * change only for nav keys.
 *
 * Every area file is imported statically per language: the bundler sees
 * each JSON file (no import context over a template string), and
 * global.d.ts types the merged shape from the English files.
 * i18n/messages.test.ts checks that en and de have the same keys and ICU
 * arguments in every file, and that en.json itself has no `manage` key the
 * merge would overwrite.
 */
import type { Locale } from "./locale";

/** The /manage namespaces of phase 1 (batch 15), each one file per language. */
export const MANAGE_MESSAGE_AREAS = [
  "common",
  "announcements",
  "events",
  "polls",
  "quickLinks",
] as const;

export type ManageMessageArea = (typeof MANAGE_MESSAGE_AREAS)[number];

type JsonModule = Promise<{ default: Record<string, unknown> }>;

const BASE: Readonly<Record<Locale, () => JsonModule>> = {
  en: () => import("../../messages/en.json"),
  de: () => import("../../messages/de.json"),
};

const MANAGE: Readonly<Record<Locale, Readonly<Record<ManageMessageArea, () => JsonModule>>>> = {
  en: {
    common: () => import("../../messages/manage/common.en.json"),
    announcements: () => import("../../messages/manage/announcements.en.json"),
    events: () => import("../../messages/manage/events.en.json"),
    polls: () => import("../../messages/manage/polls.en.json"),
    quickLinks: () => import("../../messages/manage/quickLinks.en.json"),
  },
  de: {
    common: () => import("../../messages/manage/common.de.json"),
    announcements: () => import("../../messages/manage/announcements.de.json"),
    events: () => import("../../messages/manage/events.de.json"),
    polls: () => import("../../messages/manage/polls.de.json"),
    quickLinks: () => import("../../messages/manage/quickLinks.de.json"),
  },
};

/**
 * `base` with the area catalogs under `manage.<area>`. Throws when the base
 * already has a `manage` key (the merge would hide it).
 */
export function withManageMessages<
  T extends Record<string, unknown>,
  A extends Readonly<Record<ManageMessageArea, Record<string, unknown>>>,
>(base: T, areas: A): T & { manage: A } {
  if (Object.hasOwn(base, "manage")) {
    throw new Error("[i18n] the base catalog must not define `manage` (messages/manage/*)");
  }
  return { ...base, manage: { ...areas } };
}

/** The merged catalog of `locale`. */
export async function loadMessages(locale: Locale): Promise<Record<string, unknown>> {
  const [base, ...areas] = await Promise.all([
    BASE[locale](),
    ...MANAGE_MESSAGE_AREAS.map((area) => MANAGE[locale][area]()),
  ]);
  return withManageMessages(
    base.default,
    Object.fromEntries(MANAGE_MESSAGE_AREAS.map((area, i) => [area, areas[i].default])) as Record<
      ManageMessageArea,
      Record<string, unknown>
    >,
  );
}
