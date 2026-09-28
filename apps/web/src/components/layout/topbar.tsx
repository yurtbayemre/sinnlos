import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { SearchCommand } from "@/components/search-command";
import { signOutAction } from "@/lib/auth-actions";
import { DEMO_MODE } from "@/lib/config";
import { initials } from "@/lib/utils";
import { getNotifications } from "@/lib/notification-actions";
import { getSession } from "@/lib/session";
import { LiveNotificationBell } from "@/components/notifications/live-notification-bell";
import { getTranslations } from "next-intl/server";

export async function Topbar() {
  // One session read for the whole render (getSession() is render-scoped,
  // WD08): the name below and getNotifications() share it. The feed is the
  // same getNotifications() the bell refetches with (WD10): the newest 20
  // plus the true unread total, or the empty feed without a session user.
  // A cms failure never breaks the topbar (notifications are non-critical):
  // a failed list gives the empty feed, a failed unread count alone the
  // unread among the loaded items. Only strapi()'s NEXT_REDIRECT to /sign-in
  // escapes, so an expired session navigates the whole page. DEMO_MODE gets
  // DEMO_SESSION and the fixture notifications (lib/demo.ts).
  const [tAuth, tCommon, tProfile, session, notifications] = await Promise.all([
    getTranslations("auth"),
    getTranslations("common"),
    getTranslations("profile"),
    getSession(),
    getNotifications(),
  ]);
  const name = session?.user?.name ?? tCommon("signedOut");
  const email = session?.user?.email ?? "";

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur sm:gap-4 sm:px-6">
      <div className="hidden flex-1 md:block" />

      <div className="flex-1 sm:max-w-xl">
        <SearchCommand />
      </div>

      <div className="flex flex-1 items-center justify-end gap-2 sm:gap-3">
        {session?.user && <LiveNotificationBell initial={notifications} />}
        <ThemeToggle />
        <LocaleSwitcher />
        {session?.user ? (
          <>
            <div className="hidden text-right md:block">
              <div className="text-sm font-medium leading-none">{name}</div>
              <div className="text-xs text-muted-foreground">{email}</div>
            </div>
            <Link
              href="/profile"
              aria-label={tProfile("title")}
              className="rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
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
