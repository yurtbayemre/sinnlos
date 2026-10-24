import { describe, expect, it, vi } from "vitest";

import { createReadinessCheck, READINESS_CACHE_MS } from "./readiness";

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
  });

  it("is unavailable when the cms cannot be reached", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await createReadinessCheck(URL, down)()).toBe(false);
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
