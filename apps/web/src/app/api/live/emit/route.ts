/**
 * Internal ingest endpoint for content-free live-event pings from the CMS.
 * The secret check and the handler body live in lib/live-emit.ts (a route
 * module may only export handlers and segment config), which also documents
 * the answers and why this path must stay public in proxy.ts.
 */
import type { NextRequest } from "next/server";

import { handleLiveEmit } from "@/lib/live-emit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return handleLiveEmit(req);
}
