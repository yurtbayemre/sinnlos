import { describe, expect, it } from "vitest";
import { isPublicPath } from "./proxy";

/**
 * The proxy.ts public allowlist (S06). Two failure modes are silent in
 * production, so both directions are pinned:
 *   - an internal webhook dropped from the list gets a 307 to /sign-in and
 *     the CMS→web pipeline dies without an error (/api/live/emit, and
 *     /api/revalidate while it exists);
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

  it("keeps /api/revalidate public (current state)", () => {
    // Pinned as-is: the CMS revalidate webhook posts here session-less. A
    // later phase deletes the route; that change must update this assertion.
    expect(isPublicPath("/api/revalidate")).toBe(true);
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
