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
    console.error(`[${label}] fetch failed`, e);
    return { data: null, failed: true };
  }
}
