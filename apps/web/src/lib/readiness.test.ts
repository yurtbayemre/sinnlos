import { describe, expect, it, vi } from "vitest";

import { createReadinessCheck, READINESS_CACHE_MS, READINESS_TIMEOUT_MS } from "./readiness";

/** v0.29 S8: the web half of /healthz is strict and bounded. */

const URL = "http://cms:1337/api/health/ready";
const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("createReadinessCheck", () => {
  it("is ok only for exactly 200 {status:ok}, asked without caching or redirects", async () => {
    const fetchOk = answer(200, { status: "ok" });
    expect(await createReadinessCheck(URL, fetchOk)()).toBe(true);
    expect(fetchOk).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ cache: "no-store", redirect: "error" }),
    );
    expect(await createReadinessCheck(URL, answer(503, { status: "unavailable" }))()).toBe(false);
    expect(await createReadinessCheck(URL, answer(200, { status: "fine" }))()).toBe(false);
    expect(await createReadinessCheck(URL, answer(200, null))()).toBe(false);
    expect(await createReadinessCheck(URL, answer(200, ["ok"]))()).toBe(false);
    expect(
      await createReadinessCheck(URL, answer(200, { status: "ok", error: "db failed" }))(),
    ).toBe(false);
  });

  it("is unavailable when the cms cannot be reached", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await createReadinessCheck(URL, down)()).toBe(false);
  });

  it("answers unavailable at the deadline, for hanging headers and for a body that never ends, and aborts", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const hangingHeaders = vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      });
      const endlessBody = vi.fn(
        async () =>
          new Response(
            new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("{")) }),
            {
              status: 200,
            },
          ),
      );
      for (const fetchImpl of [hangingHeaders, endlessBody]) {
        const answer = createReadinessCheck(URL, fetchImpl)();
        await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS - 1);
        let settled = false;
        void answer.then(() => (settled = true));
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await answer).toBe(false);
      }
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the call at once when the answer is known, a non-200 body never read included", async () => {
    let signal: AbortSignal | undefined;
    const endless503 = vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response(new ReadableStream({ start: () => undefined }), { status: 503 });
    });
    expect(await createReadinessCheck(URL, endless503)()).toBe(false);
    expect(signal?.aborted).toBe(true);
  });

  it("asks once for concurrent callers and caches the answer five seconds", async () => {
    let now = 0;
    let release!: (res: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => (release = r)));
    const ready = createReadinessCheck(URL, fetchImpl, () => now);
    const answers = Promise.all(Array.from({ length: 50 }, () => ready()));
    release(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    expect(await answers).toEqual(Array.from({ length: 50 }, () => true));
    now += READINESS_CACHE_MS - 1;
    expect(await ready()).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
