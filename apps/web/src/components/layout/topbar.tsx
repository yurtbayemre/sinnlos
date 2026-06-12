import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { SearchCommand } from "@/components/search-command";
import { signOutAction } from "@/lib/auth-actions";
import { initials } from "@/lib/utils";
import { strapi, type StrapiListResponse } from "@/lib/strapi";
import type { Notification } from "@/lib/types";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { getTranslations } from "next-intl/server";

const DEMO_MODE = process.env.DEMO_MODE === "1";

export async function Topbar() {
  const tAuth = await getTranslations("auth");
  const tProfile = await getTranslations("profile");

  const session = DEMO_MODE
    ? { user: { name: "Ada Lovelace", email: "ada@sinnlos.local", image: null } }
    : await (await import("@/auth")).auth();
  const name = session?.user?.name ?? "Signed out";
  const email = session?.user?.email ?? "";

  let notifications: Notification[] = [];
  if (session?.user && !DEMO_MODE) {
    try {
      const userId = (session.user as any).id;
      if (userId) {
        const res = await strapi<StrapiListResponse<Notification>>(
          `/api/notifications?filters[recipient][id][$eq]=${userId}&populate[actor]=true&sort=createdAt:desc&pagination[pageSize]=20`,
          { noCache: true },
        );
        notifications = (res as any).data ?? [];
      }
    } catch {
      // Notifications are non-critical — don't break the topbar
    }
  }

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur sm:gap-4 sm:px-6">
      <div className="hidden flex-1 md:block" />

      <div className="flex-1 sm:max-w-xl">
        <SearchCommand />
      </div>

      <div className="flex flex-1 items-center justify-end gap-2 sm:gap-3">
        {session?.user && <NotificationBell notifications={notifications} />}
        <ThemeToggle />
        <LocaleSwitcher />
        {session?.user ? (
          <>
            <div className="hidden text-right md:block">
              <div className="text-sm font-medium leading-none">{name}</div>
              <div className="text-xs text-muted-foreground">{email}</div>
            </div>
            <Link href="/profile" aria-label={tProfile("title")}>
              <Avatar>
                {session.user.image ? <AvatarImage src={session.user.image} alt={name} /> : null}
                <AvatarFallback>{initials(name)}</AvatarFallback>
              </Avatar>
            </Link>
            {DEMO_MODE ? (
              <Button variant="ghost" size="sm" disabled>
                {tAuth("demoMode")}
              </Button>
            ) : (
              <SignOutButton label={tAuth("signOut")} />
            )}
          </>
        ) : null}
      </div>
    </header>
  );
}

function SignOutButton({ label }: { label: string }) {
  return (
    <form action={signOutAction}>
      <Button variant="ghost" size="sm" type="submit">
        {label}
      </Button>
    </form>
  );
}
