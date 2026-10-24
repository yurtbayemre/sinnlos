/**
 * GET /api/health/ready (v0.29, S8; routes/health.ts): 200
 * `{"status":"ok"}` when a `select 1` on the database answers, else 503
 * `{"status":"unavailable"}`; no other field, no error text.
 *
 * Bounded work, per process: one probe in flight at a time (it stays the
 * guard until it settles, so a hanging pool never stacks probes), its
 * result cached five seconds, and every answer within two seconds (a probe
 * still running then answers 503 and keeps running). Strapi's request log
 * still logs each call; that is left as it is.
 */
interface Context {
  status: number;
  body: unknown;
  set(field: string, value: string): void;
}

export const READY_CACHE_MS = 5_000;
export const READY_TIMEOUT_MS = 2_000;

/** A readiness check over `query` (see the module comment). */
export function createReadiness(
  query: () => Promise<unknown>,
  clock: () => number = Date.now,
): () => Promise<boolean> {
  let cached: { ok: boolean; at: number } | null = null;
  let inFlight: Promise<boolean> | null = null;
  const probe = (): Promise<boolean> => {
    inFlight ??= query()
      .then(
        () => true,
        () => false,
      )
      .then((ok) => {
        cached = { ok, at: clock() };
        inFlight = null;
        return ok;
      });
    return inFlight;
  };
  return async () => {
    if (cached && clock() - cached.at < READY_CACHE_MS) return cached.ok;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
    });
    try {
      return await Promise.race([probe(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}

let readiness: (() => Promise<boolean>) | null = null;

export default {
  async ready(ctx: Context) {
    readiness ??= createReadiness(() => strapi.db.connection.raw("select 1"));
    const ok = await readiness();
    ctx.set("Cache-Control", "no-store");
    ctx.status = ok ? 200 : 503;
    ctx.body = { status: ok ? "ok" : "unavailable" };
  },
};
