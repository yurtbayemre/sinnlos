import { describe, expect, it, vi } from "vitest";

/**
 * v0.34 (A-02): Auth.js's own sign-out endpoint answers 404 (it would clear
 * the cookie without ending the account's sessions on the cms); every other
 * Auth.js route reaches the handlers unchanged.
 */
const handled = vi.hoisted(() => [] as string[]);
vi.mock("@/auth", () => ({
  handlers: {
    GET: async (req: Request) => {
      handled.push(`GET ${new URL(req.url).pathname}`);
      return new Response("auth");
    },
    POST: async (req: Request) => {
      handled.push(`POST ${new URL(req.url).pathname}`);
      return new Response("auth");
    },
  },
}));

const { GET, POST, isSignOutPath } = await import("./auth-handlers");

const BASE = "https://intranet.example.test";

describe("Auth.js route handlers", () => {
  it.each([
    "/api/auth/signout",
    "/api/auth/signout/",
    "/api/auth/signout/local",
    "/api/auth//signout",
    "/api/auth/SignOut",
    "/api/auth/%73ignout",
    "/api/auth/signout?callbackUrl=%2F",
  ])("refuses %s with 404 for GET and POST, without Auth.js", async (path) => {
    handled.length = 0;
    expect(isSignOutPath(`${BASE}${path}`)).toBe(true);
    const get = await GET(new Request(`${BASE}${path}`) as never);
    const post = await POST(new Request(`${BASE}${path}`, { method: "POST" }) as never);
    expect([get.status, post.status]).toEqual([404, 404]);
    expect(handled).toEqual([]);
  });

  it.each([
    "/api/auth/session",
    "/api/auth/csrf",
    "/api/auth/providers",
    "/api/auth/callback/microsoft-entra-id",
    "/api/auth/signin/oidc",
    "/api/auth/callback/signout",
  ])("passes %s to Auth.js", async (path) => {
    handled.length = 0;
    expect(isSignOutPath(`${BASE}${path}`)).toBe(false);
    expect((await GET(new Request(`${BASE}${path}`) as never)).status).toBe(200);
    expect(handled).toEqual([`GET ${path}`]);
  });
});
