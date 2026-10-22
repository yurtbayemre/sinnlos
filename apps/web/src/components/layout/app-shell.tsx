import { getTranslations } from "next-intl/server";
import { PageFade } from "../page-fade";
import { ViewerMobileNav } from "./viewer-mobile-nav";
import { Sidebar } from "./sidebar";
import { SiteFooter } from "./site-footer";
import { Topbar } from "./topbar";

/** Target of the skip link; also a stable landmark id for tests and tools. */
export const MAIN_ID = "main";

export async function AppShell({ children }: { children: React.ReactNode }) {
  const tCommon = await getTranslations("common");
  return (
    <div className="flex min-h-screen bg-background">
      {/* Skip link (UI04): the first stop of the Tab order, visible only while
          focused. It moves focus past the sidebar and topbar to <main>, which
          takes focus through tabIndex -1 without joining the Tab order. */}
      <a
        href={`#${MAIN_ID}`}
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-70 focus:rounded-xl focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-hidden focus:ring-2 focus:ring-ring"
      >
        {tCommon("skipToContent")}
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        {/* Below md, room for the bottom nav: 5rem plus the home indicator's
            safe-area inset (issue #71; 0 without one). */}
        <main
          id={MAIN_ID}
          tabIndex={-1}
          className="flex-1 px-4 pb-[calc(5rem+env(safe-area-inset-bottom))] pt-6 outline-hidden sm:px-6 md:pb-8 md:pt-8"
        >
          <div className="mx-auto w-full max-w-6xl">
            <PageFade>{children}</PageFade>
          </div>
          {/* Inside <main>, so it stays above the bottom nav's room. */}
          <SiteFooter className="mx-auto mt-12 max-w-6xl" />
        </main>
      </div>
      <ViewerMobileNav />
    </div>
  );
}
