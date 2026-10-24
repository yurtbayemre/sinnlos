/**
 * The web half of the readiness check (v0.29, S8; app/healthz/route.ts):
 * asks the cms's GET /api/health/ready and answers true only for exactly
 * 200 `{"status":"ok"}`. Bounded per process: one upstream call in flight
 * (it stays the guard until it settles), its result cached five seconds,
 * every answer within three seconds. No HTTP caching, no redirects.
 */
export const READINESS_CACHE_MS = 5_000;
export const READINESS_TIMEOUT_MS = 3_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * One upstream call, false after READINESS_TIMEOUT_MS at the latest: the
 * deadline covers the headers and the body (a body that never ends counts
 * too), and aborts the request.
 */
async function upstreamOk(url: string, fetchImpl: Fetch): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, READINESS_TIMEOUT_MS);
  });
  const ask = async (): Promise<boolean> => {
    const res = await fetchImpl(url, {
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (res.status !== 200) return false;
    const body: unknown = await res.json();
    // Exactly {"status":"ok"}: any other field means something else answered.
    return (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      Object.keys(body).join() === "status" &&
      (body as { status: unknown }).status === "ok"
    );
  };
  try {
    return await Promise.race([ask().catch(() => false), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function createReadinessCheck(
  url: string,
  fetchImpl: Fetch = fetch,
  clock: () => number = Date.now,
): () => Promise<boolean> {
  let cached: { ok: boolean; at: number } | null = null;
  let inFlight: Promise<boolean> | null = null;
  return () => {
    if (cached && clock() - cached.at < READINESS_CACHE_MS) return Promise.resolve(cached.ok);
    inFlight ??= upstreamOk(url, fetchImpl).then((ok) => {
      cached = { ok, at: clock() };
      inFlight = null;
      return ok;
    });
    return inFlight;
  };
}
