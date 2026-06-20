import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import Script from "next/script";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: {
    default: "Sinnlos Intranet",
    template: "%s · Sinnlos",
  },
  description: "Self-hosted company intranet",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} suppressHydrationWarning className={inter.variable}>
      <body className="font-sans antialiased">
        {/* Plausible Analytics — cookielos, selbst gehostet (DSGVO). script.js
            trackt Next.js-Client-Navigationen automatisch via History API. */}
        <Script
          data-domain="sinnlos.yurtbay.dev"
          src="https://plausible.yurtbay.dev/js/script.js"
          strategy="afterInteractive"
        />
        <NextIntlClientProvider messages={messages}>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
            {children}
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
