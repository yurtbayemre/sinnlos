import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WD08: one Auth.js session read per render scope, and one DEMO_MODE source.
 *
 * React's cache() memoises only inside a server render; outside one (this
 * test, a Server Action, a Route Handler) it is a pass-through. So `react`
 * is mocked with a cache() that memoises per "render scope" the test opens
 * and closes (`newRenderScope`), which is what the RSC renderer does per
 * request. With it, every session consumer of a render (the page's own
 * getSession(), getViewer(), strapi()'s bearer token through
 * getStrapiToken(), the topbar's notification feed) must share ONE auth()
 * call; a consumer that called auth() directly would show up as a second.
 *
 * Mocked: `@/auth` (auth() counts its calls), `@/lib/strapi-token` (the JWT
 * from the cookie), `@/lib/config` (DEMO_MODE toggle, CMS URL) and fetch.
 * lib/session.ts, lib/viewer.ts, lib/strapi.ts, lib/demo.ts and
 * lib/notification-actions.ts are the real modules.
 */
const scope = vi.hoisted(() => ({ memo: new Map<unknown, unknown>(), demo: false }));
const authMock = vi.fn<() => Promise<unknown>>();
const jwtMock = vi.fn<() => Promise<string | null>>();
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  // One memo per function per render scope (every cached function here
  // takes no arguments).
  cache:
    <R>(fn: () => R) =>
    (): R => {
      if (!scope.memo.has(fn)) scope.memo.set(fn, fn());
      return scope.memo.get(fn) as R;
    },
}));
vi.mock("@/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/strapi-token", () => ({ getStrapiJwt: () => jwtMock() }));
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  STRAPI_URL: "http://cms.test",
  get DEMO_MODE() {
    return scope.demo;
  },
}));
vi.stubGlobal("fetch", fetchMock);

const { DEMO_SESSION, getSession, getStrapiToken } = await import("./session");
const { DEMO_VIEWER, getViewer } = await import("./viewer");
const { strapi } = await import("./strapi");
const { getNotifications } = await import("./notification-actions");

const SESSION = { user: { id: 7, name: "Member" }, expires: "2999-01-01T00:00:00.000Z" };

/** A fresh RSC render: nothing memoised yet. */
const newRenderScope = () => scope.memo.clear();

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  newRenderScope();
  scope.demo = false;
  authMock.mockReset();
  authMock.mockResolvedValue(SESSION);
  jwtMock.mockReset();
  jwtMock.mockResolvedValue("jwt-abc");
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url) =>
    url.endsWith("/api/me")
      ? json({ data: { id: 7, role: { type: "member" } } })
      : json({ data: [], meta: { pagination: { page: 1, pageSize: 20, pageCount: 1, total: 0 } } }),
  );
});

describe("getSession() — one session read per render scope", () => {
  it("decodes the session once for every read of one render", async () => {
    const reads = await Promise.all([getSession(), getSession(), getSession()]);
    expect(reads).toEqual([SESSION, SESSION, SESSION]);
    expect(authMock).toHaveBeenCalledTimes(1);
  });

  it("reads again in the next render", async () => {
    await getSession();
    newRenderScope();
    await getSession();
    expect(authMock).toHaveBeenCalledTimes(2);
  });

  it("serves strapi()'s bearer token from the same read", async () => {
    await getSession();
    await strapi("/api/polls");
    await strapi("/api/announcements");
    expect(authMock).toHaveBeenCalledTimes(1);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer jwt-abc");
    }
  });

  it("shares one read between a page, the viewer and the topbar's notification feed", async () => {
    await Promise.all([getSession(), getViewer(), getNotifications(), getStrapiToken()]);
    expect(authMock).toHaveBeenCalledTimes(1);
    // The feed asked for the session user's own notifications.
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls.filter((url) => url.includes("/api/notifications?"))).toHaveLength(2);
    expect(
      urls.every((url) => !url.includes("/api/notifications?") || url.includes("[$eq]=7&")),
    ).toBe(true);
  });

  it("has no token and no feed without a session", async () => {
    authMock.mockResolvedValue(null);
    expect(await getStrapiToken()).toBeNull();
    expect(await getNotifications()).toEqual({ items: [], unreadTotal: 0 });
    expect(jwtMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(authMock).toHaveBeenCalledTimes(1);
  });
});

describe("DEMO_MODE (the one source: lib/config.ts)", () => {
  beforeEach(() => {
    scope.demo = true;
  });

  it("answers the typed demo session, with the fixture user's id, without auth()", async () => {
    expect(await getSession()).toBe(DEMO_SESSION);
    expect(DEMO_SESSION.user.id).toBe(1);
    // The demo viewer is the same person.
    expect(DEMO_SESSION.user.id).toBe(DEMO_VIEWER.id);
    expect(DEMO_SESSION.user.name).toBe(DEMO_VIEWER.displayName);
    expect(Object.isFrozen(DEMO_SESSION) && Object.isFrozen(DEMO_SESSION.user)).toBe(true);
    expect(authMock).not.toHaveBeenCalled();
  });

  it("hands out no Strapi token", async () => {
    expect(await getStrapiToken()).toBeNull();
    expect(jwtMock).not.toHaveBeenCalled();
  });

  it("reaches the notifications through the demo session (a populated bell)", async () => {
    const feed = await getNotifications();
    expect(feed.items.length).toBeGreaterThan(0);
    expect(feed.unreadTotal).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(authMock).not.toHaveBeenCalled();
  });
});
