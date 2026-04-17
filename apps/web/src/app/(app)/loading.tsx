import { RouteProgress } from "@/components/route-progress";

export default function Loading() {
  return (
    <>
      <RouteProgress />
      {/* The text only fades in if the transition takes longer than ~180ms,
          so instant navigations don't flash "Loading…". */}
      <div
        className="flex min-h-[30vh] items-center justify-center text-sm text-muted-foreground opacity-0 animate-fade-in-up"
        style={{ animationDelay: "180ms", animationFillMode: "both" }}
      >
        Loading…
      </div>
    </>
  );
}
