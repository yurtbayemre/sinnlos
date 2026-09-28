"use client";

import { usePathname } from "next/navigation";

/**
 * Remounts its children whenever the pathname changes so the fade-in
 * animation retriggers on every client-side navigation. Keeps the
 * transition from skeleton/loading → real content feeling soft instead
 * of abrupt, without any layout shift.
 *
 * The animation leaves no transform behind (fill mode `backwards`, UI01):
 * a lasting transform on this wrapper made it the containing block of every
 * `fixed` element on the page. It still exists for the 0.3 s of the
 * animation, so overlays stay portaled to <body> (defense in depth).
 */
export function PageFade({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="animate-fade-in-up">
      {children}
    </div>
  );
}
