import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  BLOCK_STATUS_MAX_ENTRIES,
  BLOCK_STATUS_TTL_MS,
  BlockStatusCache,
  checkUploadAccess,
  probeAccountStatus,
  tokenTag,
  userCheckUrl,
} from "./upload-block-cache";

/**
 * FX41: the /uploads block-status map and the Strapi probe (owner default:
 * bounded, in process, 60 s). Pinned:
 *   1. the map: TTL, answers only for the JWT an entry was checked with,
 *      bounded (the oldest write goes first), never holds the raw JWT,
 *   2. the probe: a no-store GET /api/users/me with the session's JWT;
 *      401 or a blocked flag = blocked, 200 = active, anything else
 *      (403, 5xx, network, bad JSON) = unavailable,
 *   3. checkUploadAccess: caches active/blocked (never unavailable), one
 *      probe in flight per user and JWT, nothing cached without a user id.
 * The route itself is covered in app/uploads/[...path]/route.test.ts.
 */

type FetchMock = ReturnType<typeof vi.fn<(input: string, init: RequestInit) => Promise<Response>>>;

const fetchWith = (...responses: Array<Response | Error>): FetchMock => {
  const mock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();
  for (const response of responses) {
    if (response instanceof Error) mock.mockRejectedValueOnce(response);
    else mock.mockResolvedValueOnce(response);
  }
  return mock;
};

const me = (blocked = false) => Response.json({ id: 7, documentId: "u7", blocked });

describe("BlockStatusCache", () => {
  it("remembers a status for the TTL, then forgets it", () => {
    let now = 1_000;
    const cache = new BlockStatusCache(60_000, 10, () => now);
    cache.set(7, "tag-a", "blocked");
    expect(cache.get(7, "tag-a")).toBe("blocked");
    now += 59_999;
    expect(cache.get(7, "tag-a")).toBe("blocked");
    now += 1;
    expect(cache.get(7, "tag-a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("answers only for the JWT the entry was checked with", () => {
    const cache = new BlockStatusCache();
    cache.set(7, "old-token", "blocked");
    expect(cache.get(7, "new-token")).toBeUndefined();
    cache.set(7, "new-token", "active");
    expect(cache.get(7, "new-token")).toBe("active");
    expect(cache.get(7, "old-token")).toBeUndefined();
  });

  it("is bounded: the oldest write goes first, a rewrite counts as new", () => {
    const cache = new BlockStatusCache(60_000, 3);
    cache.set(1, "t", "active");
    cache.set(2, "t", "active");
    cache.set(3, "t", "active");
    cache.set(1, "t", "blocked"); // 1 is now the newest
    cache.set(4, "t", "active");
    expect(cache.size).toBe(3);
    expect(cache.get(2, "t")).toBeUndefined();
    expect(cache.get(1, "t")).toBe("blocked");
    expect(cache.get(3, "t")).toBe("active");
    expect(cache.get(4, "t")).toBe("active");
  });

  it("defaults to a 60 s TTL and a cap of 1000 users", () => {
    expect(BLOCK_STATUS_TTL_MS).toBe(60_000);
    expect(BLOCK_STATUS_MAX_ENTRIES).toBe(1000);
    const cache = new BlockStatusCache();
    for (let id = 0; id < 1500; id++) cache.set(id, "t", "active");
    expect(cache.size).toBe(1000);
  });

  it("keys by a SHA-256 of the JWT, never the JWT itself", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6N30.sig";
    expect(tokenTag(jwt)).toBe(createHash("sha256").update(jwt).digest("hex"));
    expect(tokenTag(jwt)).not.toContain(jwt);
  });
});

describe("probeAccountStatus", () => {
  it("GETs the caller's own profile with the JWT, uncached and bounded in time", async () => {
    const fetchMock = fetchWith(me());
    expect(await probeAccountStatus("http://cms.test", "jwt-1", fetchMock)).toBe("active");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(userCheckUrl("http://cms.test"));
    expect(url).toBe("http://cms.test/api/users/me?fields[0]=blocked");
    expect(init.headers).toEqual({ Authorization: "Bearer jwt-1" });
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps Strapi's answers", async () => {
    const cases: Array<[Response | Error, string]> = [
      [new Response("Unauthorized", { status: 401 }), "blocked"],
      [me(true), "blocked"],
      [me(false), "active"],
      [new Response("Forbidden", { status: 403 }), "unavailable"],
      [new Response("err", { status: 500 }), "unavailable"],
      [new Response("err", { status: 502 }), "unavailable"],
      [new Response("not json", { status: 200 }), "unavailable"],
      [Response.json(null), "unavailable"],
      [new TypeError("fetch failed"), "unavailable"],
    ];
    for (const [answer, expected] of cases) {
      expect(await probeAccountStatus("http://cms.test", "jwt", fetchWith(answer))).toBe(expected);
    }
  });
});

describe("checkUploadAccess", () => {
  it("caches active and blocked per user and JWT", async () => {
    const cache = new BlockStatusCache();
    const fetchMock = fetchWith(me(), new Response(null, { status: 401 }));
    const check = (userId: number, jwt: string) =>
      checkUploadAccess({ userId, jwt, strapiUrl: "http://cms.test", fetchImpl: fetchMock, cache });

    expect(await check(7, "jwt-7")).toBe("active");
    expect(await check(7, "jwt-7")).toBe("active");
    expect(await check(8, "jwt-8")).toBe("blocked");
    expect(await check(8, "jwt-8")).toBe("blocked");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never caches unavailable", async () => {
    const cache = new BlockStatusCache();
    const fetchMock = fetchWith(new Response("down", { status: 503 }), me());
    const check = () =>
      checkUploadAccess({
        userId: 7,
        jwt: "jwt",
        strapiUrl: "http://cms.test",
        fetchImpl: fetchMock,
        cache,
      });
    expect(await check()).toBe("unavailable");
    expect(await check()).toBe("active");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends one probe for concurrent requests of the same user and JWT", async () => {
    const cache = new BlockStatusCache();
    let release: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    const check = () =>
      checkUploadAccess({
        userId: 7,
        jwt: "jwt",
        strapiUrl: "http://cms.test",
        fetchImpl: fetchMock,
        cache,
      });
    const all = Promise.all([check(), check(), check()]);
    await Promise.resolve();
    release(me());
    expect(await all).toEqual(["active", "active", "active"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("probes every time without a user id", async () => {
    const cache = new BlockStatusCache();
    const fetchMock = fetchWith(me(), me());
    const check = () =>
      checkUploadAccess({
        userId: undefined,
        jwt: "jwt",
        strapiUrl: "http://cms.test",
        fetchImpl: fetchMock,
        cache,
      });
    await check();
    await check();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });
});
