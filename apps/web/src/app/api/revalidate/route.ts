/**
 * Webhook endpoint called by Strapi lifecycle hooks to invalidate Next.js
 * cache tags immediately when content changes. Without this, edits in the
 * CMS don't appear on the frontend until the ISR revalidate timer expires
 * (30–60s, see apps/web/src/lib/strapi.ts).
 *
 * Auth: a shared secret is checked against the REVALIDATE_SECRET env var.
 * Both this service and the CMS must be configured with the same value.
 */
import { timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "REVALIDATE_SECRET is not configured" }, { status: 503 });
  }

  const provided = req.headers.get("x-revalidate-secret");
  const a = provided ? Buffer.from(provided) : null;
  const b = Buffer.from(secret);
  if (!a || a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { tags?: unknown } | null;
  const tags = Array.isArray(body?.tags)
    ? (body!.tags as unknown[]).filter((t): t is string => typeof t === "string" && t.length > 0)
    : [];

  for (const tag of tags) {
    // { expire: 0 } is load-bearing (SOTA-audit find, issue #30): the
    // "default" cacheLife profile has `expire: never`, so entries were
    // only marked stale and editors kept seeing old content until the
    // ISR timer + next request. The docs recommend exactly this form
    // for webhook invalidation — it matches the old single-arg
    // behaviour ("behaves like { expire: 0 }").
    revalidateTag(tag, { expire: 0 });
  }

  return NextResponse.json({ revalidated: tags });
}
