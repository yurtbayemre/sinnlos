import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { LiveEventsProvider } from "@/components/live/live-events-provider";
import { DEMO_MODE } from "@/lib/config";
import { getViewer } from "@/lib/viewer";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // v0.27: a session whose role needs a second factor it has not set up
  // yet may use nothing but the setup page (the cms refuses its other
  // requests with 403 MfaSetupRequired, which strapi() sends there too).
  if ((await getViewer()).mfaRestricted) redirect("/mfa/setup");
  // Kill switch (plan WP7): LIVE_EVENTS_DISABLED=1 keeps the provider
  // inert client-side too — never-opened stream = degraded from t=0, the
  // wrappers poll at today's 10s/30s intervals. DEMO_MODE has no live
  // backend wiring either.
  const liveEnabled = process.env.LIVE_EVENTS_DISABLED !== "1" && !DEMO_MODE;
  return (
    <LiveEventsProvider enabled={liveEnabled}>
      <AppShell>{children}</AppShell>
    </LiveEventsProvider>
  );
}
