import Link from "next/link";
import { FlaskConical, LogOut, type LucideIcon } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { SearchCommand } from "@/components/search-command";
import { DEMO_MODE } from "@/lib/config";
import { initials } from "@/lib/utils";
import { getNotifications } from "@/lib/notification-actions";
import { getSession } from "@/lib/session";
import { LiveNotificationBell } from "@/components/notifications/live-notification-bell";
import { LiveStatus } from "@/components/live/live-status";
import { SignOutForm } from "./sign-out-form";
import { getTranslations } from "next-intl/server";

export async function Topbar() {
  // One session read for the whole render (getSession() is render-scoped,
  // WD08): the name below and getNotifications() share it. The feed is the
  // same getNotifications() the bell refetches with (WD10): the newest 20
  // plus the true unread total, or the empty feed without a session user.
  // A cms failure never breaks the topbar (notifications are non-critical):
  // a failed list gives the empty feed flagged `unavailable` (the panel
  // then shows only the outage note), a failed unread count alone the
  // unread among the loaded items. Only strapi()'s NEXT_REDIRECT to /sign-in
  // escapes, so an expired session navigates the whole page. DEMO_MODE gets
  // DEMO_SESSION and the fixture notifications (lib/demo/).
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
    <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur-sm sm:gap-4 sm:px-6">
      <div className="hidden flex-1 md:block" />

      {/* min-w-0: the search box shrinks (its placeholder truncates) instead
          of pushing the header wider than the space beside the sidebar. */}
      <div className="min-w-0 flex-1 sm:max-w-xl">
        <SearchCommand />
      </div>

      <div className="flex flex-1 items-center justify-end gap-2 sm:gap-3">
        {/* The live stream's delayed note (LF05 degraded, 8C-T01): empty
            while the stream is healthy. */}
        {session?.user && <LiveStatus />}
        {session?.user && <LiveNotificationBell initial={notifications} />}
        <ThemeToggle />
        <LocaleSwitcher />
        {session?.user ? (
          <>
            {/* From lg only (at md the header has 512 px beside the
                sidebar), capped and truncated: a long e-mail no longer
                pushes Sign out off-screen. leading-tight, not none: the
                truncation clips at the line box, which would cut the
                descenders. */}
            <div className="hidden min-w-0 max-w-48 text-right lg:block">
              <div className="truncate text-sm font-medium leading-tight">{name}</div>
              <div className="truncate text-xs text-muted-foreground">{email}</div>
            </div>
            <Link
              href="/profile"
              // The shown initials are part of the name (WCAG 2.5.3).
              aria-label={`${tProfile("title")} ${initials(name)}`}
              className="rounded-full outline-hidden transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Avatar>
                {session.user.image ? <AvatarImage src={session.user.image} alt={name} /> : null}
                <AvatarFallback>{initials(name)}</AvatarFallback>
              </Avatar>
            </Link>
            {DEMO_MODE ? (
              <Button variant="ghost" size="sm" disabled className={PHONE_ICON_BUTTON}>
                <PhoneIconLabel icon={FlaskConical} label={tAuth("demoMode")} />
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
    <SignOutForm>
      <Button variant="ghost" size="sm" type="submit" className={PHONE_ICON_BUTTON}>
        <PhoneIconLabel icon={LogOut} label={label} />
      </Button>
    </SignOutForm>
  );
}

/**
 * Below `sm` the last button of the bar (Sign out, or the Demo mode badge)
 * shows only its icon, square like the other h-9 controls: with its label
 * the controls needed more than a 360 px phone has (the search button slid
 * under the bell, by 14 px with "Abmelden"; "Demo-Modus" also pushed the
 * page 6 px sideways). The label stays the accessible name (sr-only); from
 * `sm` up the button shows the label alone, on one line, as before.
 */
const PHONE_ICON_BUTTON = "w-9 px-0 sm:w-auto sm:px-3";

function PhoneIconLabel({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <>
      <Icon aria-hidden="true" className="h-4 w-4 sm:hidden" />
      <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">{label}</span>
    </>
  );
}
