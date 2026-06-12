import { BarChart3, BookOpen, Building2, Calendar, Contact, FileText, Home, Megaphone, Users2, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/roles";
import { NavLink } from "./nav-link";

const nav = [
  { href: "/", label: "Dashboard", icon: Home },
  { href: "/people", label: "People", icon: Contact },
  { href: "/events", label: "Events", icon: Calendar },
  { href: "/wiki", label: "Wiki", icon: BookOpen },
  { href: "/departments", label: "Departments", icon: Building2 },
  { href: "/teams", label: "Teams", icon: Users2 },
  { href: "/announcements", label: "Announcements", icon: Megaphone },
  { href: "/polls", label: "Polls", icon: BarChart3 },
  { href: "/documents", label: "Documents", icon: FileText },
] as const;

export async function Sidebar({ className }: { className?: string }) {
  const session = await auth();
  const role = (session?.user as any)?.role as string | undefined;
  const showAdmin = isAdmin(role);

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
        {showAdmin && <NavLink href="/admin" label="Admin" icon={Settings} />}
      </nav>
      <div className="shrink-0 border-t p-4 text-xs text-muted-foreground">
        Self-hosted intranet · v0.1
      </div>
    </aside>
  );
}
