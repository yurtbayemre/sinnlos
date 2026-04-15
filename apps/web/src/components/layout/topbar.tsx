import { Search } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { signOutAction } from "@/lib/auth-actions";
import { initials } from "@/lib/utils";

const DEMO_MODE = process.env.DEMO_MODE === "1";

export async function Topbar() {
  const session = DEMO_MODE
    ? { user: { name: "Ada Lovelace", email: "ada@sinnlos.local", image: null } }
    : await (await import("@/auth")).auth();
  const name = session?.user?.name ?? "Signed out";
  const email = session?.user?.email ?? "";

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b bg-background/80 px-6 backdrop-blur">
      <div className="flex-1" />

      <div className="relative w-full max-w-xl flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          placeholder="Search wiki, people, teams…"
          className="h-10 w-full rounded-xl border bg-muted/40 pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="flex flex-1 items-center justify-end gap-3">
        <ThemeToggle />
        {session?.user ? (
          <>
            <div className="hidden text-right md:block">
              <div className="text-sm font-medium leading-none">{name}</div>
              <div className="text-xs text-muted-foreground">{email}</div>
            </div>
            <Avatar>
              {session.user.image ? <AvatarImage src={session.user.image} alt={name} /> : null}
              <AvatarFallback>{initials(name)}</AvatarFallback>
            </Avatar>
            {DEMO_MODE ? (
              <Button variant="ghost" size="sm" disabled>
                Demo mode
              </Button>
            ) : (
              <SignOutButton />
            )}
          </>
        ) : null}
      </div>
    </header>
  );
}

function SignOutButton() {
  return (
    <form action={signOutAction}>
      <Button variant="ghost" size="sm" type="submit">
        Sign out
      </Button>
    </form>
  );
}
