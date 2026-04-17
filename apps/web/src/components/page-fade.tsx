"use client";

import { usePathname } from "next/navigation";

/**
 * Remounts its children whenever the pathname changes so the fade-in
 * animation retriggers on every client-side navigation. Keeps the
 * transition from skeleton/loading → real content feeling soft instead
 * of abrupt, without any layout shift.
 */
export function PageFade({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="animate-fade-in-up">
      {children}
    </div>
  );
}
