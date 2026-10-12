import { unstable_rethrow } from "next/navigation";

/**
 * Wraps a Strapi fetch so callers can distinguish "the CMS is down" from
 * "the CMS returned an empty list". Renders on the frontend as an error
 * banner + normal empty state instead of a misleading "no content yet".
 */
export async function tryFetch<T>(
  fn: () => Promise<T>,
  label = "strapi",
): Promise<{ data: T | null; failed: boolean }> {
  try {
    return { data: await fn(), failed: false };
  } catch (e) {
    // Next.js control-flow errors (redirect() on 401, notFound()) must
    // propagate — swallowing them would render an empty page instead of
    // navigating.
    unstable_rethrow(e);
    console.error(`[${label}] fetch failed`, e);
    return { data: null, failed: true };
  }
}

/**
 * A read the page did not send: the viewer's role cannot read the section
 * (lib/roles.ts isReadDenied, SH02), so nothing was asked and nothing
 * failed. Same shape as a tryFetch() result, so loaders treat both alike.
 */
export const SKIPPED_READ: { data: null; failed: false } = Object.freeze({
  data: null,
  failed: false,
});
