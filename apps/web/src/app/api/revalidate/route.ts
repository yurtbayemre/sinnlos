/**
 * Webhook endpoint called by Strapi lifecycle hooks to invalidate Next.js
 * cache tags immediately when content changes. Without this, edits in the
 * CMS don't appear on the frontend until the ISR revalidate timer expires
 * (30–60s, see apps/web/src/lib/strapi.ts).
 *
 * Auth: a shared secret is checked against the REVALIDATE_SECRET env var.
 * Both this service and the CMS must be configured with the same value.
 */
import { revalidateTag } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "REVALIDATE_SECRET is not configured" },
      { status: 503 },
    );
  }

  const provided = req.headers.get("x-revalidate-secret");
  if (provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { tags?: unknown } | null;
  const tags = Array.isArray(body?.tags)
    ? (body!.tags as unknown[]).filter(
        (t): t is string => typeof t === "string" && t.length > 0,
      )
    : [];

  for (const tag of tags) {
    // Next.js 16 requires a cacheLife profile — "default" matches the
    // behavior of single-arg revalidateTag in earlier versions.
    revalidateTag(tag, "default");
  }

  return NextResponse.json({ revalidated: tags });
}
