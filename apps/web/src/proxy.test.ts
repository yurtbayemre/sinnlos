import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `@/auth` is mocked for the proxy() cases at the end (auth() counts its
 * calls), and `@/lib/config` so that DEMO_MODE can be switched per case;
 * isPublicPath is pure.
 */
const state = vi.hoisted(() => ({ demo: false, authImported: false }));
const authMock = vi.fn<() => Promise<unknown>>();
vi.mock("@/auth", () => {
  state.authImported = true;
  return { auth: () => authMock() };
});
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  get DEMO_MODE() {
    return state.demo;
  },
}));

const { default: proxy, isPublicPath } = await import("./proxy");

/**
 * The proxy.ts public allowlist (S06). Two failure modes are silent in
 * production, so both directions are pinned:
 *   - an internal webhook dropped from the list gets a 307 to /sign-in and
 *     the CMS→web pipeline dies without an error (/api/live/emit — the only
 *     one left since D-DC01 removed /api/revalidate);
 *   - a per-session path added to it (/uploads bytes, /live/* SSE) becomes
 *     anonymously reachable. /uploads/* re-checks auth() in its route, but
 *     the bytes must never depend on a single layer.
 * PUBLIC_FILES is an EXACT set so that an authenticated route whose slug
 * merely ends in .png/.xml cannot slip past the guard.
 */

describe("isPublicPath — public entries", () => {
  it("lets the auth pages through", () => {
    expect(isPublicPath("/sign-in")).toBe(true);
    expect(isPublicPath("/register")).toBe(true);
  });

  it("lets the Auth.js endpoints through", () => {
    for (const path of [
      "/api/auth",
      "/api/auth/session",
      "/api/auth/csrf",
      "/api/auth/callback/microsoft-entra-id",
      "/api/auth/callback/local",
    ]) {
      expect(isPublicPath(path)).toBe(true);
    }
  });

  it("keeps the internal live-event ingest public (secret-gated in its route)", () => {
    expect(isPublicPath("/api/live/emit")).toBe(true);
  });

  it("lets Next assets and the favicon through", () => {
    expect(isPublicPath("/_next/static/chunks/main.js")).toBe(true);
    expect(isPublicPath("/_next/image")).toBe(true);
    expect(isPublicPath("/favicon.ico")).toBe(true);
  });

  it("lets exactly the listed well-known root files through", () => {
    for (const path of [
      "/robots.txt",
      "/sitemap.xml",
      "/site.webmanifest",
      "/manifest.webmanifest",
      "/apple-touch-icon.png",
      "/apple-touch-icon-precomposed.png",
    ]) {
      expect(isPublicPath(path)).toBe(true);
    }
  });
});

describe("isPublicPath — guarded paths", () => {
  it("never makes the upload bytes public", () => {
    for (const path of ["/uploads", "/uploads/", "/uploads/report_abc123.pdf", "/uploads/x.png"]) {
      expect(isPublicPath(path)).toBe(false);
    }
  });

  it("never makes the live SSE endpoints public", () => {
    for (const path of ["/live", "/live/stream", "/live/subscribe"]) {
      expect(isPublicPath(path)).toBe(false);
    }
  });

  it("guards the removed /api/revalidate webhook like any other path (D-DC01)", () => {
    // The Strapi fetch cache and its tag webhook are gone; /api/live/emit is
    // the only session-less internal endpoint left. A stale CMS POST here
    // just gets the sign-in redirect.
    expect(isPublicPath("/api/revalidate")).toBe(false);
  });

  it("guards app pages and the ICS export", () => {
    for (const path of ["/", "/wiki/onboarding", "/people/42", "/events/abc123/ics"]) {
      expect(isPublicPath(path)).toBe(false);
    }
  });

  it("matches the auth pages and webhooks exactly, not by prefix", () => {
    for (const path of [
      "/sign-in2",
      "/sign-in/x",
      "/register2",
      "/register/x",
      "/api/live",
      "/api/live/emit/x",
      "/api/live/emitx",
      "/api/revalidate/x",
      "/api/revalidatex",
    ]) {
      expect(isPublicPath(path)).toBe(false);
    }
  });

  it("is case-sensitive", () => {
    for (const path of ["/Sign-In", "/API/revalidate", "/api/Live/emit", "/Robots.txt"]) {
      expect(isPublicPath(path)).toBe(false);
    }
  });

  it("does not let .png/.xml/.txt lookalikes of PUBLIC_FILES through", () => {
    for (const path of [
      "/wiki/logo.png",
      "/wiki/apple-touch-icon.png",
      "/apple-touch-icon.png/x",
      "/apple-touch-icon.png.png",
      "/apple-touch-icon-120x120.png",
      "/reports/sitemap.xml",
      "/robots.txt/",
      "/robots.txtx",
      "/marketplace/item.webmanifest",
    ]) {
      expect(isPublicPath(path)).toBe(false);
    }
  });

  it("does not list the app-dir icon routes (current state)", () => {
    // /icon.png and /apple-icon.png (app/ metadata routes, #33) are not in
    // PUBLIC_FILES today, so anonymous requests get the sign-in redirect.
    expect(isPublicPath("/icon.png")).toBe(false);
    expect(isPublicPath("/apple-icon.png")).toBe(false);
  });
});

describe("isPublicPath — raw prefix entries (current state)", () => {
  it("matches /api/auth, /_next and /favicon as raw string prefixes", () => {
    // No Next route lives on these shapes, so they only ever 404. Keep it
    // that way: anything placed under such a prefix is public.
    expect(isPublicPath("/api/authx")).toBe(true);
    expect(isPublicPath("/_nextx")).toBe(true);
    expect(isPublicPath("/favicon-32x32.png")).toBe(true);
  });
});

/** A request as the proxy sees it; `cookie` and the action header are optional. */
function request(
  path: string,
  { method = "GET", cookie, action }: { method?: string; cookie?: string; action?: boolean } = {},
): NextRequest {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (action) headers.set("next-action", "7f3a9c");
  return new NextRequest(`https://intranet.example.test${path}`, { method, headers });
}

/** NextResponse.next() marks "continue" with this header. */
const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

const PUBLIC_REQUESTS = [
  "/sign-in",
  "/register",
  "/api/auth/session",
  "/api/live/emit",
  "/robots.txt",
];

describe("proxy() — no session decode where none is needed (WD08)", () => {
  beforeEach(() => {
    state.demo = false;
    authMock.mockReset();
    authMock.mockResolvedValue(null);
  });

  it("lets DEMO_MODE through before importing @/auth", async () => {
    state.demo = true;
    for (const path of ["/", "/wiki/x", "/uploads/a.png"]) {
      expect(passes(await proxy(request(path))), path).toBe(true);
    }
    expect(authMock).not.toHaveBeenCalled();
    expect(state.authImported).toBe(false);
  });

  it("never calls auth() on a public path (nor imports @/auth for it)", async () => {
    for (const path of PUBLIC_REQUESTS) {
      expect(passes(await proxy(request(path))), path).toBe(true);
      expect(passes(await proxy(request(path, { method: "POST", action: true }))), path).toBe(true);
    }
    expect(authMock).not.toHaveBeenCalled();
    expect(state.authImported).toBe(false);
  });

  it("decodes the session once per guarded request", async () => {
    authMock.mockResolvedValue({ user: { id: 7 } });
    expect(passes(await proxy(request("/wiki/handbook")))).toBe(true);
    expect(authMock).toHaveBeenCalledTimes(1);
  });
});

describe("proxy() — a request without a session", () => {
  const STALE_COOKIE = "authjs.session-token=eyJhbGciOiJkaXIifQ.stale";

  beforeEach(() => {
    state.demo = false;
    authMock.mockReset();
    authMock.mockResolvedValue(null);
  });

  it("sends a page load to /sign-in with the path to return to", async () => {
    const res = await proxy(request("/wiki/handbook"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://intranet.example.test/sign-in?from=%2Fwiki%2Fhandbook",
    );
  });

  it("adds expired=1 when the request still carries a session cookie (the session ended)", async () => {
    for (const cookie of [
      STALE_COOKIE,
      "__Secure-authjs.session-token=x",
      "theme=dark; authjs.session-token.0=a; authjs.session-token.1=b",
    ]) {
      const res = await proxy(request("/polls", { cookie }));
      expect(res.headers.get("location"), cookie).toBe(
        "https://intranet.example.test/sign-in?expired=1&from=%2Fpolls",
      );
    }
    // Other cookies are no session.
    const other = await proxy(request("/polls", { cookie: "authjs.csrf-token=x; theme=dark" }));
    expect(other.headers.get("location")).toBe(
      "https://intranet.example.test/sign-in?from=%2Fpolls",
    );
  });

  it("answers an expired Server Action with the action redirect to /sign-in?expired=1 (batch-6 deferral)", async () => {
    const res = await proxy(
      request("/polls/new", { method: "POST", action: true, cookie: STALE_COOKIE }),
    );
    // Not a 307: Next's action client would follow it as a POST to /sign-in
    // and fail. The shape Next itself answers a redirect() in an action with.
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-action-redirect")).toBe(
      "/sign-in?expired=1&from=%2Fpolls%2Fnew;push",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(passes(res)).toBe(false);
    expect(await res.text()).toBe("");
  });

  it("answers an action without any session cookie with the plain sign-in path", async () => {
    const res = await proxy(request("/kudos", { method: "POST", action: true }));
    expect(res.headers.get("x-action-redirect")).toBe("/sign-in?from=%2Fkudos;push");
  });

  it("treats a form post without the action header like a page", async () => {
    const res = await proxy(request("/kudos", { method: "POST", cookie: STALE_COOKIE }));
    expect(res.status).toBe(307);
    expect(res.headers.get("x-action-redirect")).toBeNull();
  });

  it("lets a Server Action with a session through", async () => {
    authMock.mockResolvedValue({ user: { id: 7 } });
    const res = await proxy(request("/polls/new", { method: "POST", action: true }));
    expect(passes(res)).toBe(true);
    expect(res.headers.get("x-action-redirect")).toBeNull();
  });
});
