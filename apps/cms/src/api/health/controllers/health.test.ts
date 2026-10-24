import { afterEach, describe, expect, it, vi } from "vitest";

import { createReadiness, READY_CACHE_MS, READY_TIMEOUT_MS } from "./health";

/** v0.29 S8: the cms readiness probe is bounded (single flight, cache, timeout). */

afterEach(() => {
  vi.useRealTimers();
});

describe("createReadiness", () => {
  it("answers ok when the query answers and caches it for five seconds", async () => {
    let now = 0;
    const query = vi.fn(async () => [{ "?column?": 1 }]);
    const ready = createReadiness(query, () => now);
    expect(await ready()).toBe(true);
    now += READY_CACHE_MS - 1;
    expect(await ready()).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    now += 1;
    expect(await ready()).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("answers unavailable when the query fails", async () => {
    const ready = createReadiness(async () => {
      throw new Error("connection refused");
    });
    expect(await ready()).toBe(false);
  });

  it("runs one probe for concurrent callers", async () => {
    let release!: () => void;
    const query = vi.fn(() => new Promise<void>((r) => (release = r)));
    const ready = createReadiness(query);
    const answers = Promise.all(Array.from({ length: 50 }, () => ready()));
    release();
    expect(await answers).toEqual(Array.from({ length: 50 }, () => true));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("answers unavailable after the timeout and keeps the hanging probe as the only one", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const query = vi.fn(() => new Promise<void>((r) => (release = r)));
    const ready = createReadiness(query, () => Date.now());
    const first = ready();
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    expect(await first).toBe(false);
    const second = ready();
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    expect(await second).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(await ready()).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
