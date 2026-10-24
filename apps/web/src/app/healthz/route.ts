import { NextResponse } from "next/server";
import { STRAPI_URL } from "@/lib/config";
import { createReadinessCheck } from "@/lib/readiness";

/**
 * GET /healthz (v0.29, S8): the readiness check for monitors, through the
 * whole chain: edge → web → cms (GET /api/health/ready over the internal
 * URL) → database. Outside /api on purpose: the edge sends /api/* to the
 * cms. Public in proxy.ts. 200 `{"status":"ok"}` or 503
 * `{"status":"unavailable"}`, never more; per process at most one upstream
 * call in flight and the answer cached five seconds (lib/readiness.ts).
 * It proves connectivity only, not the schema, search, mail or the crons.
 */
export const dynamic = "force-dynamic";

const ready = createReadinessCheck(`${STRAPI_URL}/api/health/ready`);

export async function GET() {
  const ok = await ready();
  return NextResponse.json(
    { status: ok ? "ok" : "unavailable" },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
