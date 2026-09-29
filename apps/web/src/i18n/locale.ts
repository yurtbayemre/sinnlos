import { cookies } from "next/headers";

export const SUPPORTED_LOCALES = ["en", "de"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

function isSupportedLocale(value: unknown): value is Locale {
  return SUPPORTED_LOCALES.includes(value as Locale);
}

/**
 * The language of a visitor without a `locale` cookie when DEFAULT_LOCALE
 * is unset or invalid: English (owner decision 2026-09-29, AC04), the same
 * default as compose, the .env examples, the user schema's `locale` and the
 * cms's DIGEST_DEFAULT_LOCALE.
 */
export const FALLBACK_LOCALE: Locale = "en";

// Validate the env value instead of blindly casting it — a typo (e.g.
// DEFAULT_LOCALE=De) would otherwise crash every request when next-intl
// tries to import a messages file that doesn't exist.
const envLocale = process.env.DEFAULT_LOCALE;
if (envLocale && !isSupportedLocale(envLocale)) {
  console.warn(
    `[i18n] DEFAULT_LOCALE="${envLocale}" is not one of ${SUPPORTED_LOCALES.join(", ")} — falling back to "${FALLBACK_LOCALE}".`,
  );
}
const DEFAULT_LOCALE: Locale = isSupportedLocale(envLocale) ? envLocale : FALLBACK_LOCALE;

export async function getUserLocale(): Promise<Locale> {
  const jar = await cookies();
  const cookie = jar.get("locale")?.value as Locale | undefined;
  if (cookie && SUPPORTED_LOCALES.includes(cookie)) return cookie;
  return DEFAULT_LOCALE;
}

export async function setUserLocale(locale: Locale) {
  const jar = await cookies();
  jar.set("locale", locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
}
