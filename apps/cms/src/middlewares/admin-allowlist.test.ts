import { describe, expect, it, vi } from "vitest";
import adminAllowlist, {
  ADMIN_ROOTS,
  DEFAULT_ADMIN_ALLOW_CIDRS,
  isAdminPath,
  parseAdminAllowList,
} from "./admin-allowlist";

describe("isAdminPath", () => {
  it.each([
    "/admin",
    "/admin/",
    "/admin/init",
    "/ADMIN/init",
    "/Admin/content-api/permissions",
    "/upload",
    "/upload/files",
    "/email",
    "/Email/settings",
    "/content-manager/collection-types/api::poll.poll",
    "/content-type-builder/content-types",
    "/users-permissions/roles",
    "/i18n/locales",
    "/review-workflows/workflows",
    "/content-releases",
    // Encoded and dot spellings the router may still resolve.
    "/%61dmin/init",
    "/%2fadmin",
    "//admin",
    "/api/../admin/init",
    "/x/..%2Fupload/files",
  ])("covers %s", (path) => {
    expect(isAdminPath(path)).toBe(true);
  });

  it.each([
    "/",
    "/api/upload",
    "/api/auth/local",
    "/api/polls",
    "/uploads/photo.png",
    "/administrator",
    "/emails",
    "/i18nx",
    "/_health",
    "/%E0%A4%A",
  ])("leaves %s alone", (path) => {
    expect(isAdminPath(path)).toBe(false);
  });

  it("lists every root once, lower case", () => {
    expect(new Set(ADMIN_ROOTS).size).toBe(ADMIN_ROOTS.length);
    for (const root of ADMIN_ROOTS) expect(root).toBe(root.toLowerCase());
  });
});

describe("parseAdminAllowList", () => {
  it.each([undefined, "", "   "])("takes loopback only for %j", (value) => {
    const list = parseAdminAllowList(value);
    expect(list.cidrs.join(",")).toBe(DEFAULT_ADMIN_ALLOW_CIDRS);
    expect(list.open).toBe(false);
    for (const ip of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      expect(list.allows(ip), ip).toBe(true);
    }
    for (const ip of ["172.18.0.1", "10.0.0.5", "203.0.113.9", "::2", "2001:db8::1"]) {
      expect(list.allows(ip), ip).toBe(false);
    }
  });

  it("allows the listed IPv4 and IPv6 networks, and nothing else (loopback included)", () => {
    const list = parseAdminAllowList(" 203.0.113.0/24 , 2001:db8::/48,198.51.100.7/32");
    expect(list.cidrs).toEqual(["203.0.113.0/24", "2001:db8::/48", "198.51.100.7/32"]);
    expect(list.allows("203.0.113.9")).toBe(true);
    expect(list.allows("::ffff:203.0.113.200")).toBe(true);
    expect(list.allows("2001:db8:0:1::5")).toBe(true);
    expect(list.allows("198.51.100.7")).toBe(true);
    expect(list.allows("198.51.100.8")).toBe(false);
    expect(list.allows("2001:db9::1")).toBe(false);
    expect(list.allows("127.0.0.1")).toBe(false);
    expect(list.allows("")).toBe(false);
    expect(list.allows("not-an-ip")).toBe(false);
  });

  it("marks a /0 entry as open", () => {
    const list = parseAdminAllowList("0.0.0.0/0,::/0");
    expect(list.open).toBe(true);
    expect(list.allows("8.8.8.8")).toBe(true);
    expect(list.allows("2a00:1450::1")).toBe(true);
  });

  it.each([
    "203.0.113.9",
    "203.0.113.0/33",
    "2001:db8::/129",
    "intranet.example.com/24",
    "203.0.113.0/24,",
    "203.0.113.0/24,,10.0.0.0/8",
    "203.0.113.0/24 10.0.0.0/8",
    "*",
  ])("refuses %j", (value) => {
    expect(() => parseAdminAllowList(value)).toThrow(
      /ADMIN_ALLOW_CIDRS: ".*" is not an IPv4 or IPv6 CIDR/,
    );
  });
});

describe("the admin-allowlist middleware", () => {
  const strapi = () => ({ log: { info: vi.fn(), warn: vi.fn() } });

  async function run(
    allow: string | undefined,
    ctx: { path: string; ip: string; method?: string },
  ) {
    const host = strapi();
    const gate = adminAllowlist({ allow }, { strapi: host });
    const next = vi.fn(async () => undefined);
    const c: { path: string; ip: string; method: string; status?: number; body?: unknown } = {
      method: "GET",
      ...ctx,
    };
    await gate(c, next);
    return { ctx: c, next, log: host.log };
  }

  it("refuses an admin path from outside the list with a 403, and logs it", async () => {
    const { ctx, next, log } = await run(undefined, { path: "/admin/init", ip: "203.0.113.9" });
    expect(next).not.toHaveBeenCalled();
    expect(ctx.status).toBe(403);
    expect(ctx.body).toMatchObject({ data: null, error: { status: 403, name: "ForbiddenError" } });
    expect(log.info).toHaveBeenCalledWith(
      "[admin-allowlist] refused GET /admin/init from 203.0.113.9",
    );
  });

  it("lets loopback, listed clients and every non-admin path through", async () => {
    expect(
      (await run(undefined, { path: "/admin/init", ip: "::ffff:127.0.0.1" })).next,
    ).toHaveBeenCalled();
    expect(
      (await run("203.0.113.0/24", { path: "/upload", ip: "203.0.113.9" })).next,
    ).toHaveBeenCalled();
    expect(
      (await run(undefined, { path: "/api/polls", ip: "203.0.113.9" })).next,
    ).toHaveBeenCalled();
    expect(
      (await run(undefined, { path: "/uploads/a.png", ip: "203.0.113.9" })).next,
    ).toHaveBeenCalled();
  });

  it("fails at creation on a malformed list, and warns once about an open one", () => {
    expect(() => adminAllowlist({ allow: "10.0.0.0" }, { strapi: strapi() })).toThrow(
      /ADMIN_ALLOW_CIDRS/,
    );
    const host = strapi();
    adminAllowlist({ allow: "0.0.0.0/0" }, { strapi: host });
    expect(host.log.warn).toHaveBeenCalledTimes(1);
    expect(host.log.warn.mock.calls[0][0]).toContain(
      "opens the Strapi admin panel to every client",
    );
  });
});
