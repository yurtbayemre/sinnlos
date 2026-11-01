import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  revokeAllSessions,
  SIGN_OUT_NOTICE_COOKIE,
  SIGN_OUT_TIMEOUT_MS,
  signOutNoticeCookie,
  signOutNoticeShown,
} from "./sign-out-notice";

/**
 * v0.34 (A-02): the cms call of the sign-out (true only for a 2xx, never a
 * throw, bounded) and the /sign-in notice cookie (set by the action, read
 * by the page on the first return, Microsoft's round trip included: Lax).
 */
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("revokeAllSessions", () => {
  const call = (answer: () => Promise<Response>) => {
    const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(answer);
    return {
      fetchImpl,
      result: revokeAllSessions({ strapiUrl: "http://cms.test", jwt: "the.jwt", fetchImpl }),
    };
  };

  it("posts to /api/me/sign-out with the JWT, no-store and a bounded signal", async () => {
    const { fetchImpl, result } = call(async () => new Response(null, { status: 204 }));
    expect(await result).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://cms.test/api/me/sign-out");
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      headers: { Authorization: "Bearer the.jwt" },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(SIGN_OUT_TIMEOUT_MS).toBe(5_000);
  });

  it.each([
    ["a 401", async () => new Response("", { status: 401 })],
    ["a 503", async () => new Response("", { status: 503 })],
    [
      "a network error",
      async (): Promise<Response> => Promise.reject(new TypeError("fetch failed")),
    ],
  ])("answers false after %s, without throwing", async (_, answer) => {
    expect(await call(answer).result).toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.warn).mock.calls[0]![0])).not.toContain("the.jwt");
  });

  it("gives up after its timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_, reject) =>
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
          ),
      );
      const result = revokeAllSessions({
        strapiUrl: "http://cms.test",
        jwt: "the.jwt",
        fetchImpl,
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(await result).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the notice cookie", () => {
  it("is HttpOnly, Lax (sent on the top-level return from Microsoft), for /sign-in, 5 minutes", () => {
    expect(signOutNoticeCookie(true)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/sign-in",
      maxAge: 300,
    });
    expect(signOutNoticeCookie(false).secure).toBe(false);
  });

  it("shows the notice on /sign-in while the cookie the action set is there", () => {
    const jar = (value?: string) => ({
      get: (name: string) => (name === SIGN_OUT_NOTICE_COOKIE && value ? { value } : undefined),
    });
    expect(signOutNoticeShown(jar("1"))).toBe(true);
    expect(signOutNoticeShown(jar())).toBe(false);
    expect(signOutNoticeShown(jar("0"))).toBe(false);
  });
});
