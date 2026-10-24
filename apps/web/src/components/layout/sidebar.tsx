import { cn } from "@/lib/utils";
import { navItemsFor } from "@/lib/nav-config";
import { brand, DEFAULT_SITE_NAME } from "@/lib/site-config";
import { getViewer } from "@/lib/viewer";
import { BrandMark } from "./brand-mark";
import { NavLink } from "./nav-link";
import { getTranslations } from "next-intl/server";

/**
 * The desktop navigation (md and up): every entry of lib/nav-config.ts the
 * viewer's role may use (navItemsFor). The phone tab bar maps the same
 * entries (mobile-nav.tsx).
 */
export async function Sidebar({ className }: { className?: string }) {
  const [t, tCommon, viewer] = await Promise.all([
    getTranslations("nav"),
    getTranslations("common"),
    // Role per request from the CMS (D-SESSION-01) — never from the session.
    getViewer(),
  ]);
  const items = navItemsFor(viewer.role);
  const { name, logoUrl } = brand(process.env);
  const siteName = name ?? DEFAULT_SITE_NAME;

  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r bg-card/40 backdrop-blur-sm md:flex",
        className,
      )}
    >
      <div className="flex h-16 shrink-0 items-center gap-2 border-b px-6">
        <BrandMark name={siteName} logoUrl={logoUrl} className="h-8 w-8 rounded-xl" />
        <span className="font-semibold tracking-tight">{siteName}</span>
      </div>
      <nav aria-label={tCommon("mainNav")} className="flex-1 space-y-1 overflow-y-auto p-4">
        {items.map((item) => (
          <NavLink key={item.href} href={item.href} label={t(item.labelKey)} icon={item.icon} />
        ))}
      </nav>
      <div className="shrink-0 border-t p-4 text-xs text-muted-foreground">
        {tCommon("selfHosted")}
      </div>
    </aside>
  );
}
