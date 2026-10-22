import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import Script from "next/script";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { plausibleScript } from "@/lib/site-config";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: {
    default: "Sinnlos Intranet",
    template: "%s · Sinnlos",
  },
  description: "Self-hosted company intranet",
};

/**
 * `viewport-fit=cover` (issue #71): without it iOS reports every
 * env(safe-area-inset-*) as 0, so the phone tab bar's bottom inset never
 * applied and its entries sat on the home indicator. With it the page
 * draws edge to edge: the tab bar, the main column and the bottom-anchored
 * messages add the bottom inset, and <html> the side insets of a
 * landscape notch (globals.css). Every inset is 0 on a device without one.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  const plausible = plausibleScript(process.env);

  return (
    <html lang={locale} suppressHydrationWarning className={inter.variable}>
      <body className="font-sans antialiased">
        {/* Plausible (cookieless) only when the operator configures it
            (v0.26, M2); script.js follows Next.js client navigations via
            the History API. */}
        {plausible && (
          <Script data-domain={plausible.domain} src={plausible.src} strategy="afterInteractive" />
        )}
        <NextIntlClientProvider messages={messages}>
          {/* disableTransitionOnChange: without it every colour transition
              in the UI animates during a theme switch (FX31). */}
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            {children}
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
