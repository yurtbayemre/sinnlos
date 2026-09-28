import { getRequestConfig } from "next-intl/server";
import { appTimeZone } from "@/lib/app-time-zone";
import { getUserLocale } from "./locale";

/**
 * next-intl's per-request config. `timeZone` is APP_TIME_ZONE (datetime
 * contract, deep-dive decision 04, C6): every getFormatter().dateTime in a
 * server component formats in it, and NextIntlClientProvider in the root
 * layout hands the same zone to the client (next-intl 4.13
 * NextIntlClientProviderServer: `timeZone ?? await getTimeZone()`), so
 * useFormatter()/useTimeZone() in client components agree with the server
 * render. Without it next-intl falls back to the process zone, which is UTC
 * in the container.
 */
export default getRequestConfig(async () => {
  const locale = await getUserLocale();
  return {
    locale,
    timeZone: appTimeZone(),
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
