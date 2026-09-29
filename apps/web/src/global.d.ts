/**
 * next-intl's app-wide types (AC03): the locales and the message catalog's
 * shape. With Messages typed from en.json, every t("key") is checked at
 * compile time — a key missing from en.json is a type error, not a
 * MISSING_MESSAGE at render — and ICU arguments are typed. de.json must
 * carry the same keys and arguments (i18n/messages.test.ts).
 */
import type en from "../messages/en.json";
import type { Locale as AppLocale } from "@/i18n/locale";

declare module "next-intl" {
  interface AppConfig {
    Locale: AppLocale;
    Messages: typeof en;
  }
}
