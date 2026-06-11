import { PageFade } from "../page-fade";
import { MobileNav } from "./mobile-nav";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        {/* pb-20 leaves room for the mobile bottom nav on small screens */}
        <main className="flex-1 px-4 pb-20 pt-6 sm:px-6 md:pb-8 md:pt-8">
          <div className="mx-auto w-full max-w-6xl">
            <PageFade>{children}</PageFade>
          </div>
        </main>
      </div>
      <MobileNav />
    </div>
  );
}
