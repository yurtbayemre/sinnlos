import { cookies } from "next/headers";

export const SUPPORTED_LOCALES = ["en", "de"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

const DEFAULT_LOCALE: Locale =
  (process.env.DEFAULT_LOCALE as Locale) || "en";

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
