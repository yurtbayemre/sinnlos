/**
 * D-EDGE-01: case-variant / encoded spellings of Strapi's /api/auth/* routes
 * must never reach the (case-insensitive) Strapi router, while the literal
 * lowercase form every internal caller sends passes untouched.
 */
import { describe, expect, it } from "vitest";

import authPathGuard, { isCaseVariantAuthPath } from "./auth-path-guard";

describe("isCaseVariantAuthPath", () => {
  it.each([
    "/api/auth/local",
    "/api/auth/local/register",
    "/api/auth/change-password",
    "/api/auth/microsoft/callback",
    "/api/auth/forgot-password",
    "/api/auth/email-confirmation",
    // Literal lowercase prefix: the edge routes these to the web anyway.
    "/api/auth/LOCAL",
    "/api/auth/local/",
  ])("lets the literal lowercase form %s through", (path) => {
    expect(isCaseVariantAuthPath(path)).toBe(false);
  });

  it.each([
    "/api/Auth/local",
    "/API/AUTH/LOCAL",
    "/Api/auth/local",
    "/api/aUTH/local/register",
    "/api/AUTH/change-password",
    "/api/Auth/microsoft/callback",
    "/api/Auth",
    "/api/Auth/",
    "/api/auth",
  ])("blocks the case variant %s", (path) => {
    expect(isCaseVariantAuthPath(path)).toBe(true);
  });

  it.each([
    "/api/%61uth/local",
    "/api/%41uth/local",
    "/%61pi/auth/local",
    "/api%2fauth/local",
    "/api%2Fauth%2Flocal",
    "/api/auth%2flocal",
    "/api%5cauth/local",
  ])("blocks the encoded form %s", (path) => {
    expect(isCaseVariantAuthPath(path)).toBe(true);
  });

  it.each([
    "/api//auth/local",
    "/api/./auth/local",
    "/api/x/../auth/local",
    "/api/%2e%2e/api/Auth/local",
    "/api/users/..%2fAuth/local",
    "/api/foo/../../api/auth/local/register",
  ])("blocks the traversal / non-canonical form %s", (path) => {
    expect(isCaseVariantAuthPath(path)).toBe(true);
  });

  it.each([
    "/api/authors",
    "/api/authx/local",
    "/api/users/me",
    "/api/upload",
    "/api/me",
    "/admin/login",
    "/api/connect/microsoft",
    "/api/auth/../users/me",
    "/",
    "",
  ])("ignores unrelated path %s", (path) => {
    expect(isCaseVariantAuthPath(path)).toBe(false);
  });

  it("checks only the raw form for a malformed escape", () => {
    expect(isCaseVariantAuthPath("/api/%E0%A4%A/auth/local")).toBe(false);
    expect(isCaseVariantAuthPath("/api/Auth/%zz")).toBe(true);
  });

  it("honours a custom REST prefix", () => {
    expect(isCaseVariantAuthPath("/rest/Auth/local", "/rest")).toBe(true);
    expect(isCaseVariantAuthPath("/rest/auth/local", "/rest")).toBe(false);
    expect(isCaseVariantAuthPath("/api/Auth/local", "/rest")).toBe(false);
  });
});

describe("auth-path-guard middleware", () => {
  const strapiWith = (prefix?: unknown) => ({
    config: {
      get: (key: string, fallback?: unknown) =>
        key === "api.rest.prefix" && prefix !== undefined ? prefix : fallback,
    },
  });

  async function run(path: string, prefix?: unknown) {
    const middleware = authPathGuard(undefined, { strapi: strapiWith(prefix) });
    const ctx: { path?: string; status?: number } = { path };
    let nextCalled = false;
    await middleware(ctx, async () => {
      nextCalled = true;
    });
    return { status: ctx.status, nextCalled };
  }

  it("answers a bare 404 for a case variant without reaching the router", async () => {
    await expect(run("/api/Auth/local")).resolves.toEqual({ status: 404, nextCalled: false });
    await expect(run("/api/%61uth/local/register")).resolves.toEqual({
      status: 404,
      nextCalled: false,
    });
  });

  it("passes the literal lowercase path and unrelated paths through", async () => {
    await expect(run("/api/auth/local")).resolves.toEqual({
      status: undefined,
      nextCalled: true,
    });
    await expect(run("/api/users/me")).resolves.toEqual({ status: undefined, nextCalled: true });
  });

  it("uses the configured REST prefix and falls back to /api", async () => {
    await expect(run("/rest/Auth/local", "/rest")).resolves.toEqual({
      status: 404,
      nextCalled: false,
    });
    await expect(run("/api/Auth/local", "")).resolves.toEqual({ status: 404, nextCalled: false });
    await expect(run("/api/Auth/local", 42)).resolves.toEqual({ status: 404, nextCalled: false });
  });
});
