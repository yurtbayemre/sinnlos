/**
 * next-intl's app-wide types (AC03): the locales and the message catalog's
 * shape. With Messages typed from en.json, keys and namespaces are checked
 * at compile time: a t("key") or useTranslations("namespace") missing from
 * en.json is a type error, not a MISSING_MESSAGE at render.
 *
 * ICU arguments are NOT type-checked: a plain JSON import types every
 * message as `string`, so t("key") without its `{min}` still compiles.
 * next-intl's strict arguments need a generated declaration
 * (createMessagesDeclaration) and allowArbitraryExtensions in the
 * tsconfig; not enabled. de.json must carry the same keys and the same
 * ICU arguments as en.json (checked by i18n/messages.test.ts).
 */
import type en from "../messages/en.json";
import type { Locale as AppLocale } from "@/i18n/locale";

declare module "next-intl" {
  interface AppConfig {
    Locale: AppLocale;
    Messages: typeof en;
  }
}
