import { PageFade } from "../page-fade";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 px-6 py-8">
          <div className="mx-auto w-full max-w-6xl">
            <PageFade>{children}</PageFade>
          </div>
        </main>
      </div>
    </div>
  );
}
