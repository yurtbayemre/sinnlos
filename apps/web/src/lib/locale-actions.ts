"use server";

import { setUserLocale, type Locale } from "@/i18n/locale";

export async function switchLocale(locale: Locale) {
  await setUserLocale(locale);
}
