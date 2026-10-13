import { getRequestConfig } from "next-intl/server";
import { appTimeZone } from "@/lib/app-time-zone";
import { getUserLocale } from "./locale";
import { loadMessages } from "./messages";

/**
 * next-intl's per-request config. `timeZone` is APP_TIME_ZONE (datetime
 * contract, deep-dive decision 04, C6): every getFormatter().dateTime in a
 * server component formats in it, and NextIntlClientProvider in the root
 * layout hands the same zone to the client (next-intl 4.13
 * NextIntlClientProviderServer: `timeZone ?? await getTimeZone()`), so
 * useFormatter()/useTimeZone() in client components agree with the server
 * render. Without it next-intl falls back to the process zone, which is UTC
 * in the container.
 *
 * `messages` is the language's whole catalog: messages/<locale>.json plus
 * the /manage area files under `manage.<area>` (i18n/messages.ts, decision
 * 06 §L7).
 */
export default getRequestConfig(async () => {
  const locale = await getUserLocale();
  return {
    locale,
    timeZone: appTimeZone(),
    messages: await loadMessages(locale),
  };
});
