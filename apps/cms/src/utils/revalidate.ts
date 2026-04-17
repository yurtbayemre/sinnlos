/**
 * Fire-and-forget POST to the Next.js /api/revalidate endpoint so the
 * frontend invalidates its cached Strapi fetches the moment content
 * changes in the CMS. Falls back silently if env vars aren't set so
 * local dev without the webhook still works.
 *
 * The frontend's cache tags are defined in apps/web/src/lib/strapi.ts.
 */
export async function revalidate(tags: string[]): Promise<void> {
  const webUrl = process.env.WEB_INTERNAL_URL;
  const secret = process.env.REVALIDATE_SECRET;

  if (!webUrl || !secret || tags.length === 0) return;

  try {
    await fetch(`${webUrl}/api/revalidate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-revalidate-secret": secret,
      },
      body: JSON.stringify({ tags }),
      // Short timeout — we don't want a slow frontend to slow down
      // Strapi's write path.
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    // Log but never throw — failing to revalidate must not fail the save.
    // eslint-disable-next-line no-console
    console.warn(
      `[revalidate] notify failed (${tags.join(",")}): ${(err as Error).message}`,
    );
  }
}
