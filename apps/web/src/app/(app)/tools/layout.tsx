import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";

/**
 * The /tools subtree's own message provider: the root layout leaves the `tools`
 * and `processes` namespaces out of every page's payload (i18n/messages.ts
 * TOOLS_MESSAGE_NAMESPACES), and the client components of these pages (the PDF
 * and QR tools, the process viewer) read them. The whole catalog, asked for
 * explicitly, so this does not depend on whether next-intl merges a nested
 * provider's messages with the parent's.
 */
export default async function ToolsLayout({ children }: { children: React.ReactNode }) {
  return <NextIntlClientProvider messages={await getMessages()}>{children}</NextIntlClientProvider>;
}
