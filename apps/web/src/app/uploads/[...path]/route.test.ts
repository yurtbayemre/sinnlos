import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadBlockCache } from "@/lib/upload-block-cache";
import { uploadDecisionCache } from "@/lib/upload-decision";

/**
 * The /uploads byte proxy with the FX41 revocation check. Pinned:
 *   1. no session or no Strapi JWT: 401 before any cms request; an invalid
 *      path: 404 before the check,
 *   2. every other request first asks Strapi whether the session's JWT is
 *      still accepted (no-store GET /api/me with that JWT); a blocked
 *      or rejected account gets 401 and no bytes, a cms that cannot say
 *      gets 503 and no bytes,
 *   3. the answer is reused for 60 s per user and JWT (one check for a
 *      page of images), so a block reaches the files within the TTL, a new
 *      sign-in (another JWT) is checked on its own, and two sessions of the
 *      same user do not evict each other,
 *   4. an accepted request streams the bytes as before (S06 headers); a
 *      byte fetch that fails (network error, or no response headers within
 *      the 30 s connect bound) is a 503 without bytes, also when the check
 *      came from the map,
 *   5. (v0.34, B1) between the account check and the bytes the cms decides
 *      for this viewer and this file (POST /api/auth/uploads/access with the
 *      JWT and the internal secret): `deny` is a 404 before any byte or
 *      Range request, a cms that cannot say a 503; the answer is reused for
 *      60 s per user and file, so a retargeted document or another account
 *      in the same browser is asked again.
 *
 * `@/lib/session` is mocked (the real module pulls in next-auth), as are
 * `@/lib/config` and global fetch; the block-status and decision maps are
 * the real ones.
 */
const getSessionMock = vi.fn<() => Promise<{ user?: { id?: number } } | null>>();
const getStrapiTokenMock = vi.fn<() => Promise<string | null>>();
const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();

vi.mock("@/lib/session", () => ({
  getSession: () => getSessionMock(),
  getStrapiToken: () => getStrapiTokenMock(),
}));
vi.mock("@/lib/config", () => ({ STRAPI_URL: "http://cms.test" }));
vi.stubGlobal("fetch", fetchMock);

const { GET } = await import("./route");

const CHECK = "http://cms.test/api/me";
const ACCESS = "http://cms.test/api/auth/uploads/access";
const FILE = "http://cms.test/uploads/report_abc123.pdf";

function get(path: string[] = ["report_abc123.pdf"]) {
  return GET(new NextRequest(`http://web.test/uploads/${path.join("/")}`), {
    params: Promise.resolve({ path }),
  });
}

const allowed = () => Response.json({ data: { allow: true } });
const denied = () => Response.json({ data: { allow: false } });

/** Strapi: the account check answers `account`, the access question `decision`, the file %PDF. */
function cms(account: () => Response, decision: () => Response = allowed) {
  fetchMock.mockImplementation(async (url: string) =>
    url === CHECK
      ? account()
      : url === ACCESS
        ? decision()
        : new Response("%PDF-1", { status: 200, headers: { "content-type": "application/pdf" } }),
  );
}

const active = () => Response.json({ data: { id: 7, documentId: "u7", blocked: false } });
const rejected = () => new Response("Unauthorized", { status: 401 });

const urls = () => fetchMock.mock.calls.map(([url]) => url);

beforeEach(() => {
  uploadBlockCache.clear();
  uploadDecisionCache.clear();
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue({ user: { id: 7 } });
  getStrapiTokenMock.mockReset();
  getStrapiTokenMock.mockResolvedValue("jwt-7");
  fetchMock.mockReset();
  cms(active);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /uploads/[...path] (FX41)", () => {
  it("checks the session's JWT with Strapi, then streams the bytes", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("%PDF-1");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(urls()).toEqual([CHECK, ACCESS, FILE]);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toEqual({ Authorization: "Bearer jwt-7" });
    expect(init.cache).toBe("no-store");
    // The bytes go out with the internal headers only, never the user's JWT.
    const [, fileInit] = fetchMock.mock.calls[2];
    expect(new Headers(fileInit.headers).get("authorization")).toBeNull();
  });

  it("answers a video range request with 206 and the partial bytes, inline (v0.30)", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === CHECK
        ? active()
        : url === ACCESS
          ? allowed()
          : new Response("0123", {
              status: 206,
              headers: {
                "content-type": "video/mp4",
                "content-range": "bytes 0-3/100",
                "accept-ranges": "bytes",
              },
            }),
    );
    const res = await GET(
      new NextRequest("http://web.test/uploads/clip_abc123.mp4", {
        headers: { range: "bytes=0-3" },
      }),
      { params: Promise.resolve({ path: ["clip_abc123.mp4"] }) },
    );
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("0123");
    expect(res.headers.get("content-range")).toBe("bytes 0-3/100");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBeNull();
    const [, fileInit] = fetchMock.mock.calls[2];
    expect(new Headers(fileInit.headers).get("range")).toBe("bytes=0-3");
  });

  it("delivers a type outside the inline list as a sandboxed download (v0.30)", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === CHECK
        ? active()
        : url === ACCESS
          ? allowed()
          : new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } }),
    );
    const res = await get(["logo_abc123.svg"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe("attachment");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers 401 for a blocked or rejected account, without any bytes", async () => {
    cms(rejected);
    const res = await get();
    expect(res.status).toBe(401);
    expect(urls()).toEqual([CHECK]);

    uploadBlockCache.clear();
    fetchMock.mockReset();
    cms(() => Response.json({ data: { id: 7, blocked: true } }));
    expect((await get()).status).toBe(401);
    expect(urls()).toEqual([CHECK]);
  });

  it("answers 503 when Strapi cannot say, and asks again next time", async () => {
    cms(() => new Response("down", { status: 502 }));
    expect((await get()).status).toBe(503);
    fetchMock.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    expect((await get()).status).toBe(503);
    cms(active);
    expect((await get()).status).toBe(200);
    expect(urls().filter((url) => url === CHECK)).toHaveLength(3);
    expect(urls().filter((url) => url === FILE)).toHaveLength(1);
  });

  it("answers 503 when the cms is gone while the status is still cached", async () => {
    expect((await get()).status).toBe(200); // caches `active`
    fetchMock.mockImplementation(async () => {
      throw new TypeError("fetch failed"); // getaddrinfo ENOTFOUND cms
    });
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Service unavailable");
    // Both answers came from the maps; only the byte fetch reached the network.
    expect(urls()).toEqual([CHECK, ACCESS, FILE, FILE]);
  });

  it("answers 503 when the cms sends no response headers within 30 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let fileRequested: () => void = () => undefined;
    const requested = new Promise<void>((resolve) => (fileRequested = resolve));
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (url === CHECK) return Promise.resolve(active());
      if (url === ACCESS) return Promise.resolve(allowed());
      fileRequested();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        );
      });
    });
    let settled = false;
    const pending = get().finally(() => (settled = true));
    await requested;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Service unavailable");
  });

  it("reuses the answer for 60 s: one check for a page of images", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 5; i++) expect((await get()).status).toBe(200);
    expect(urls().filter((url) => url === CHECK)).toHaveLength(1);
    expect(urls().filter((url) => url === FILE)).toHaveLength(5);
  });

  it("a block reaches the files within the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    expect((await get()).status).toBe(200);
    cms(rejected); // an admin blocks the account
    vi.advanceTimersByTime(59_000);
    expect((await get()).status).toBe(200); // still inside the window
    vi.advanceTimersByTime(1_000);
    expect((await get()).status).toBe(401);
    // …and stays refused without a check per request.
    expect((await get()).status).toBe(401);
    expect(urls().filter((url) => url === CHECK)).toHaveLength(2);
  });

  it("checks a new sign-in (another JWT) on its own", async () => {
    cms(rejected);
    expect((await get()).status).toBe(401);
    getStrapiTokenMock.mockResolvedValue("jwt-7-new");
    cms(active);
    expect((await get()).status).toBe(200);
    expect(
      fetchMock.mock.calls.filter(([url]) => url === CHECK).map(([, init]) => init.headers),
    ).toEqual([{ Authorization: "Bearer jwt-7" }, { Authorization: "Bearer jwt-7-new" }]);
  });

  it("two interleaved sessions of one user: one check each, not one per switch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 5; i++) {
      getStrapiTokenMock.mockResolvedValue("jwt-7-laptop");
      expect((await get()).status).toBe(200);
      getStrapiTokenMock.mockResolvedValue("jwt-7-phone");
      expect((await get()).status).toBe(200);
    }
    expect(
      fetchMock.mock.calls.filter(([url]) => url === CHECK).map(([, init]) => init.headers),
    ).toEqual([{ Authorization: "Bearer jwt-7-laptop" }, { Authorization: "Bearer jwt-7-phone" }]);
    expect(urls().filter((url) => url === FILE)).toHaveLength(10);
  });

  it("answers 401 without a session or without a Strapi JWT, before any cms request", async () => {
    getSessionMock.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    getSessionMock.mockResolvedValue({ user: { id: 7 } });
    getStrapiTokenMock.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 404 for an invalid path before the check", async () => {
    const res = await get(["..", "secret.pdf"]);
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks every request of a session without a user id", async () => {
    getSessionMock.mockResolvedValue({ user: {} });
    await get();
    await get();
    expect(urls().filter((url) => url === CHECK)).toHaveLength(2);
  });
});

describe("GET /uploads/[...path]: the file follows its content (v0.34, B1)", () => {
  const accessCalls = () => fetchMock.mock.calls.filter(([url]) => url === ACCESS);

  it("asks the cms with the session's JWT, the internal secret and the file name", async () => {
    vi.stubEnv("INTERNAL_UPLOAD_TOKEN", "internal-secret");
    try {
      expect((await get()).status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
    const [[, init]] = accessCalls();
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer jwt-7",
      "x-internal-token": "internal-secret",
    });
    expect(JSON.parse(String(init.body))).toEqual({ name: "report_abc123.pdf" });
  });

  it("answers 404 for a denied file before any byte or Range request", async () => {
    cms(active, denied);
    const res = await GET(
      new NextRequest("http://web.test/uploads/report_abc123.pdf", {
        headers: { range: "bytes=0-3", "if-none-match": '"etag"' },
      }),
      { params: Promise.resolve({ path: ["report_abc123.pdf"] }) },
    );
    expect(res.status).toBe(404);
    expect(urls()).toEqual([CHECK, ACCESS]);
  });

  it("reads a refused question (401, 403) as a denial", async () => {
    cms(active, () => new Response("Forbidden", { status: 403 }));
    expect((await get()).status).toBe(404);
    uploadDecisionCache.clear();
    cms(active, () => new Response("Unauthorized", { status: 401 }));
    expect((await get()).status).toBe(404);
    expect(urls().filter((url) => url === FILE)).toHaveLength(0);
  });

  it("answers 503 when the cms cannot say, and asks again next time", async () => {
    cms(active, () => new Response("Not Found", { status: 404 }));
    expect((await get()).status).toBe(503);
    cms(active, () => new Response("down", { status: 502 }));
    expect((await get()).status).toBe(503);
    cms(active, () => Response.json({ data: {} }));
    expect((await get()).status).toBe(503);
    cms(active);
    expect((await get()).status).toBe(200);
    expect(accessCalls()).toHaveLength(4);
    expect(urls().filter((url) => url === FILE)).toHaveLength(1);
  });

  it("reuses an answer for 60 s per user and file: one question for a page of images", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 3; i++) expect((await get()).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await get(["team_def456.png"])).status).toBe(200);
    expect(accessCalls().map(([, init]) => JSON.parse(String(init.body)).name)).toEqual([
      "report_abc123.pdf",
      "team_def456.png",
    ]);
  });

  it("a warm URL after its content was retargeted: refused once the minute is over", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    expect((await get()).status).toBe(200);
    cms(active, denied); // the document now targets another department
    vi.advanceTimersByTime(59_000);
    expect((await get()).status).toBe(200);
    vi.advanceTimersByTime(1_000);
    expect((await get()).status).toBe(404);
  });

  it("another account in the same browser is asked on its own", async () => {
    expect((await get()).status).toBe(200);
    getSessionMock.mockResolvedValue({ user: { id: 8 } });
    getStrapiTokenMock.mockResolvedValue("jwt-8");
    cms(active, denied);
    expect((await get()).status).toBe(404);
    expect(
      accessCalls().map(([, init]) => (init.headers as Record<string, string>).Authorization),
    ).toEqual(["Bearer jwt-7", "Bearer jwt-8"]);
  });

  it("a blocked account is refused before the question", async () => {
    cms(rejected);
    expect((await get()).status).toBe(401);
    expect(accessCalls()).toHaveLength(0);
  });
});
