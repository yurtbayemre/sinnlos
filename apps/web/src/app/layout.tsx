import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import Script from "next/script";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { paletteCss } from "@/lib/contrast";
import { brand, DEFAULT_SITE_NAME, plausibleScript } from "@/lib/site-config";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

/**
 * The title and icons follow the runtime branding (v0.29, S1): SITE_NAME
 * names the instance (unset keeps "Sinnlos Intranet" / "%s · Sinnlos"), and
 * SITE_ICON_URL replaces the bundled icons. The bundled ones live in
 * public/, not in the app/ file conventions, because Next would always add a
 * convention favicon next to configured icons.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { name, iconUrl } = brand(process.env);
  return {
    title: {
      default: name ?? `${DEFAULT_SITE_NAME} Intranet`,
      // parseSiteName refuses a name with "%s": Next substitutes every one.
      template: `%s · ${name ?? DEFAULT_SITE_NAME}`,
    },
    description: "Self-hosted company intranet",
    icons: iconUrl
      ? { icon: iconUrl, apple: iconUrl }
      : {
          icon: [
            { url: "/favicon.ico", sizes: "32x32" },
            { url: "/icon.png", type: "image/png", sizes: "512x512" },
          ],
          apple: { url: "/apple-icon.png", sizes: "180x180" },
        },
  };
}

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
  const { palette } = brand(process.env);

  return (
    <html lang={locale} suppressHydrationWarning className={inter.variable}>
      {/* SITE_ACCENT's verified tokens (lib/contrast.ts), built from numbers
          only; unlayered, so they outrank the @layer base tokens of
          globals.css. */}
      {palette && (
        <head>
          <style>{paletteCss(palette)}</style>
        </head>
      )}
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
