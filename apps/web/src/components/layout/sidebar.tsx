import { cn } from "@/lib/utils";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/roles";
import { NavLink, type NavIconName } from "./nav-link";
import { getTranslations } from "next-intl/server";

export async function Sidebar({ className }: { className?: string }) {
  const t = await getTranslations("nav");
  const tCommon = await getTranslations("common");

  const session = await auth();
  const role = (session?.user as any)?.role as string | undefined;
  const showAdmin = isAdmin(role);

  const nav: { href: string; label: string; icon: NavIconName }[] = [
    { href: "/", label: t("dashboard"), icon: "Home" },
    { href: "/people", label: t("people"), icon: "Contact" },
    { href: "/events", label: t("events"), icon: "Calendar" },
    { href: "/wiki", label: t("wiki"), icon: "BookOpen" },
    { href: "/departments", label: t("departments"), icon: "Building2" },
    { href: "/teams", label: t("teams"), icon: "Users2" },
    { href: "/announcements", label: t("announcements"), icon: "Megaphone" },
    { href: "/kudos", label: t("kudos"), icon: "Award" },
    { href: "/polls", label: t("polls"), icon: "BarChart3" },
    { href: "/documents", label: t("documents"), icon: "FileText" },
  ];

  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r bg-card/40 backdrop-blur md:flex",
        className,
      )}
    >
      <div className="flex h-16 shrink-0 items-center gap-2 border-b px-6">
        <div
          aria-hidden="true"
          className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary font-bold text-primary-foreground"
        >
          S
        </div>
        <span className="font-semibold tracking-tight">Sinnlos</span>
      </div>
      <nav aria-label="Primary" className="flex-1 space-y-1 overflow-y-auto p-4">
        {nav.map((item) => (
          <NavLink key={item.href} {...item} />
        ))}
        {/* /manage, not /admin — the reverse proxy routes /admin* to the
            Strapi admin panel, which would shadow an in-app /admin page. */}
        {showAdmin && <NavLink href="/manage" label={t("admin")} icon="Settings" />}
      </nav>
      <div className="shrink-0 border-t p-4 text-xs text-muted-foreground">
        {tCommon("selfHosted")}
      </div>
    </aside>
  );
}
