import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { LiveEventsProvider } from "@/components/live/live-events-provider";
import { DEMO_MODE } from "@/lib/config";
import { buildRevision } from "@/lib/site-config";
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
  // The tab's own build revision; a stream hello with another one shows the
  // header's reload note (#214).
  return (
    <>
      {/* The referrer policy of the signed-in app (v1.1, Mermaid): a request to
          another origin carries no Referer, one to this origin keeps it. The
          edge's header says strict-origin-when-cross-origin, which would tell an
          external host the intranet's origin; a diagram's image shape
          (`A@{ img: … }`) fetches its picture with no referrerpolicy of its own,
          as Markdown images have, and every Markdown body is under this layout.
          A literal tag, not the metadata API (Next streams that after the
          page's content). Not in the root layout: a page of (auth) says its own
          (set-password: no-referrer), and the tag that comes later in the
          document wins, which at the root would be the root's. The meta wins
          over the header; an element's own referrerpolicy wins over both (the
          YouTube iframe needs its origin). React hoists the tag into <head>. */}
      <meta name="referrer" content="same-origin" />
      <LiveEventsProvider enabled={liveEnabled} revision={buildRevision(process.env)}>
        <AppShell>{children}</AppShell>
      </LiveEventsProvider>
    </>
  );
}
