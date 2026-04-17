/**
 * Thin indeterminate progress bar rendered at the top of the viewport
 * whenever Next.js is loading a new route segment. Used from the route
 * loading.tsx files so it shows on every navigation between app pages.
 */
export function RouteProgress() {
  return (
    <div
      role="progressbar"
      aria-label="Loading page"
      className="fixed left-0 right-0 top-0 z-[60] h-0.5 overflow-hidden bg-transparent"
    >
      <div className="absolute top-0 h-full rounded-full bg-primary/80 shadow-[0_0_8px_rgba(99,102,241,0.6)] animate-indeterminate" />
    </div>
  );
}
