import Link from "next/link";
import { BookOpen, Building2, Home, Megaphone, Users2, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/", label: "Dashboard", icon: Home },
  { href: "/wiki", label: "Wiki", icon: BookOpen },
  { href: "/departments", label: "Departments", icon: Building2 },
  { href: "/teams", label: "Teams", icon: Users2 },
  { href: "/announcements", label: "Announcements", icon: Megaphone },
  { href: "/admin", label: "Admin", icon: Settings },
] as const;

export function Sidebar({ className }: { className?: string }) {
  return (
    <aside
      className={cn(
        "hidden w-64 shrink-0 flex-col border-r bg-card/40 backdrop-blur md:flex",
        className,
      )}
    >
      <div className="flex h-16 items-center gap-2 border-b px-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-primary-foreground font-bold">
          S
        </div>
        <span className="font-semibold tracking-tight">Sinnlos</span>
      </div>
      <nav className="flex-1 space-y-1 p-4">
        {nav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="group flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-accent-foreground"
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="border-t p-4 text-xs text-muted-foreground">
        Self-hosted intranet · v0.1
      </div>
    </aside>
  );
}
