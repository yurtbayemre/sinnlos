"use server";

import { unstable_rethrow } from "next/navigation";
import { SUPPORTED_LOCALES, setUserLocale, type Locale } from "@/i18n/locale";
import { DEMO_MODE } from "@/lib/config";
import { getSession } from "@/lib/session";
import { strapi } from "@/lib/strapi";

/**
 * Budget of the best-effort profile write. The cookie and the re-rendered
 * page reach the browser only when this action returns, and strapi() sets
 * no timeout of its own: a CMS that accepts the connection but does not
 * answer would otherwise hold the visible switch for as long as undici
 * waits. Not exported: a "use server" module exports async functions only.
 */
const LOCALE_PROFILE_WRITE_TIMEOUT_MS = 3_000;

/**
 * Switches the UI language: the `locale` cookie decides the web's language
 * (i18n/locale.ts), and since AC04 the choice is also stored on the
 * caller's profile (PUT /api/me { locale }, a whitelisted field), so the
 * e-mail digest speaks it too (apps/cms/src/digest/render-digest.ts).
 *
 * The profile write is best-effort: a failure or a timeout
 * ({@link LOCALE_PROFILE_WRITE_TIMEOUT_MS}) keeps the switched cookie and is
 * only logged (the digest then uses the stored or the default language). It
 * is skipped in DEMO_MODE and without a session (a defensive guard: the
 * switcher is rendered only in the signed-in topbar). strapi()'s sign-in
 * redirect on an expired session propagates (NEXT_REDIRECT).
 */
export async function switchLocale(locale: Locale) {
  // A Server Action's argument comes from the client.
  if (!(SUPPORTED_LOCALES as readonly unknown[]).includes(locale)) return;
  await setUserLocale(locale);
  if (DEMO_MODE) return;
  const session = await getSession();
  if (!session?.user?.id) return;
  try {
    await strapi("/api/me", {
      method: "PUT",
      body: JSON.stringify({ data: { locale } }),
      signal: AbortSignal.timeout(LOCALE_PROFILE_WRITE_TIMEOUT_MS),
    });
  } catch (error) {
    unstable_rethrow(error);
    console.warn(
      `[locale] could not store the language on the profile: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
