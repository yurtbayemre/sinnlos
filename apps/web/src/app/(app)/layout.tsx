import { AppShell } from "@/components/layout/app-shell";
import { LiveEventsProvider } from "@/components/live/live-events-provider";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  // Kill switch (plan WP7): LIVE_EVENTS_DISABLED=1 keeps the provider
  // inert client-side too — never-opened stream = degraded from t=0, the
  // wrappers poll at today's 10s/30s intervals. DEMO_MODE has no live
  // backend wiring either.
  const liveEnabled =
    process.env.LIVE_EVENTS_DISABLED !== "1" && process.env.DEMO_MODE !== "1";
  return (
    <LiveEventsProvider enabled={liveEnabled}>
      <AppShell>{children}</AppShell>
    </LiveEventsProvider>
  );
}
