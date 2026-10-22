import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestStrapi, type TestStrapi } from "./harness.test.helper";

/**
 * The admin allowlist (v0.26, M5; src/middlewares/admin-allowlist.ts) on the
 * real cms, through its real middleware chain and router: the client is the
 * address the edge forwards (X-Forwarded-For, trusted per config/server.ts),
 * else the socket peer (127.0.0.1 here).
 *   1. default (ADMIN_ALLOW_CIDRS unset): loopback reaches the admin API, a
 *      forwarded outside client gets the 403 on every admin root, in every
 *      spelling the router accepts; /api and /uploads are not gated;
 *   2. raw paths the router matches against parameterised admin routes
 *      (`/content-manager/collection-types/../..`) are refused although
 *      they normalise out of the admin roots (sent with node:http, which,
 *      unlike fetch, keeps `..` in the request line);
 *   3. a configured list replaces loopback: its networks get in, others and
 *      loopback do not.
 * SQLite only: the gate runs before any database work.
 */

const OUTSIDE = "203.0.113.9";
const GATE = "ADMIN_ALLOW_CIDRS";

interface Answer {
  status: number;
  /** The allowlist's own refusal (its message), not another 403. */
  gated: boolean;
}

/** GET of `path` exactly as written (no client-side `..` resolution). */
function get(t: TestStrapi, path: string, forwardedFor?: string): Promise<Answer> {
  const { hostname, port } = new URL(t.baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname,
        port,
        path,
        method: "GET",
        headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            gated: res.statusCode === 403 && text.includes(GATE),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("admin allowlist: default, loopback only", () => {
  let t: TestStrapi;
  beforeAll(async () => {
    t = await createTestStrapi({ engine: "sqlite", fixtures: false });
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("lets loopback reach the admin API", async () => {
    const res = await get(t, "/admin/init");
    expect(res).toEqual({ status: 200, gated: false });
  });

  it.each([
    "/admin/init",
    "/ADMIN/init",
    "/%61dmin/init",
    "/admin/content-api/permissions",
    "/content-manager/init",
    "/upload/files",
    "/email/settings",
    "/users-permissions/roles",
    "/i18n/locales",
    "/content-type-builder/content-types",
    "/api/../admin/init",
    "/ADM%C4%B1N/init",
    // Raw admin prefixes the router routes although they normalise elsewhere.
    "/content-manager/collection-types/../..",
    "/admin/../admin/users",
    "/admin/x/../../api/users",
  ])("refuses %s to a forwarded outside client", async (path) => {
    const res = await get(t, path, OUTSIDE);
    expect(res).toEqual({ status: 403, gated: true });
  });

  it.each(["/api/polls", "/api/upload", "/api/upload/files", "/uploads/x", "/_health"])(
    "does not gate %s",
    async (path) => {
      const res = await get(t, path, OUTSIDE);
      expect(res.gated).toBe(false);
    },
  );
});

describe("admin allowlist: a configured list", () => {
  let t: TestStrapi;
  beforeAll(async () => {
    t = await createTestStrapi({
      engine: "sqlite",
      fixtures: false,
      env: { ADMIN_ALLOW_CIDRS: "203.0.113.0/24, 2001:db8::/48" },
    });
  });
  afterAll(async () => {
    await t?.stop();
  });

  it("lets its networks in, and nobody else, loopback included", async () => {
    expect(await get(t, "/admin/init", OUTSIDE)).toEqual({ status: 200, gated: false });
    expect(await get(t, "/admin/init", "2001:db8::5")).toEqual({ status: 200, gated: false });
    expect(await get(t, "/admin/init", "198.51.100.1")).toEqual({ status: 403, gated: true });
    expect(await get(t, "/admin/init")).toEqual({ status: 403, gated: true });
  });
});
