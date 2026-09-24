import { afterEach, describe, expect, it, vi } from "vitest";
import uploadsAuth, { targetsUploads, tokenMatches } from "./uploads-auth";

/**
 * The cms-side gate on the /uploads BYTES path (issue #21, review fix K1).
 *
 * The edge routes /api, /admin, … to cms as a RAW string prefix, so
 * `/api/../uploads/<hash>.pdf` and its encoded twins reach cms, where
 * koa-static would resolve the `..` back into public/uploads and serve the
 * bytes anonymously (verified live 2026-08-17). This middleware is the only
 * layer that stops that: any path that DECODES + NORMALISES under /uploads/
 * needs the shared x-internal-upload-token, which only the web proxy route
 * sends. These tests pin (S06):
 *   1. targetsUploads over raw, encoded, double-encoded and traversal forms,
 *      and /upload (media-library admin API) vs /uploads,
 *   2. tokenMatches (constant-time, length-guarded, empty never matches),
 *   3. the middleware: 404 (never 401) without a matching token, prod
 *      fail-closed when the secret is unset, dev no-op with a single warning.
 */

describe("targetsUploads — what counts as the upload bytes path", () => {
  it("matches the plain /uploads path", () => {
    for (const path of [
      "/uploads",
      "/uploads/",
      "/uploads/report_abc123.pdf",
      "/uploads/a/b.png",
    ]) {
      expect(targetsUploads(path)).toBe(true);
    }
  });

  it("does not match /upload (admin API), /api/upload or /uploads lookalikes", () => {
    for (const path of [
      "/upload",
      "/upload/files",
      "/upload/actions/bulk-delete",
      "/api/upload",
      "/uploadsx",
      "/uploads-archive/x.pdf",
      "/api/uploads",
      "/",
      "",
    ]) {
      expect(targetsUploads(path)).toBe(false);
    }
  });

  it("matches raw traversal paths that normalise under /uploads/", () => {
    for (const path of [
      "/api/../uploads/x.pdf",
      "/admin/../uploads/x.pdf",
      "/api/v1/../../uploads/x.pdf",
      "/api/../../../uploads/x.pdf",
      "/./uploads/x.pdf",
      "//uploads/x.pdf",
      "/uploads/../uploads/x.pdf",
    ]) {
      expect(targetsUploads(path)).toBe(true);
    }
  });

  it("matches once-encoded traversal and encoded-/uploads forms", () => {
    for (const path of [
      "/api/%2e%2e/uploads/x.pdf",
      "/api/%2E%2E/uploads/x.pdf",
      "/api/..%2fuploads/x.pdf",
      "/api/..%2Fuploads/x.pdf",
      "/api%2f..%2fuploads%2fx.pdf",
      "/%75ploads/x.pdf",
      "/%2e/uploads/x.pdf",
    ]) {
      expect(targetsUploads(path)).toBe(true);
    }
  });

  it("does not match double-encoded forms (decoded once, like koa-send)", () => {
    // koa-send decodes exactly once, so `%252e%252e` reaches the file system
    // as a literal `%2e%2e` directory name — no traversal, nothing to gate.
    for (const path of ["/api/%252e%252e/uploads/x.pdf", "/api/..%252fuploads/x.pdf"]) {
      expect(targetsUploads(path)).toBe(false);
    }
  });

  it("falls back to the raw form on a malformed escape", () => {
    // decodeURIComponent throws; the raw /uploads path is still caught.
    expect(targetsUploads("/uploads/%zz.pdf")).toBe(true);
    expect(targetsUploads("/uploads/%E0%A4%A.pdf")).toBe(true);
  });
});

describe("tokenMatches", () => {
  it("accepts only the identical token", () => {
    expect(tokenMatches("s3cret-token", "s3cret-token")).toBe(true);
    expect(tokenMatches("s3cret-tokeX", "s3cret-token")).toBe(false);
  });

  it("rejects unequal lengths without throwing (timingSafeEqual would)", () => {
    expect(tokenMatches("short", "much-longer-token")).toBe(false);
    expect(tokenMatches("s3cret-token-and-more", "s3cret-token")).toBe(false);
    // Same UTF-16 length, different byte length.
    expect(() => tokenMatches("ä", "a")).not.toThrow();
    expect(tokenMatches("ä", "a")).toBe(false);
  });

  it("never matches an empty value on either side", () => {
    expect(tokenMatches("", "s3cret-token")).toBe(false);
    expect(tokenMatches("s3cret-token", "")).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
  });
});

/** Minimal koa ctx: `get` returns "" for a missing header, as koa does. */
interface StubCtx {
  path: string;
  status?: number;
  get: (name: string) => string;
}

function makeCtx(path: string, headers: Record<string, string> = {}): StubCtx {
  return { path, get: (name) => headers[name.toLowerCase()] ?? "" };
}

function makeMiddleware() {
  const warn = vi.fn();
  const middleware = uploadsAuth(undefined, { strapi: { log: { warn } } });
  const run = async (ctx: StubCtx) => {
    const next = vi.fn(async () => {});
    await middleware(ctx, next);
    return next;
  };
  return { run, warn };
}

const TOKEN = "internal-upload-token-0123456789";

describe("uploads-auth middleware", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes non-upload paths through untouched, token or not", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INTERNAL_UPLOAD_TOKEN", TOKEN);
    const { run } = makeMiddleware();
    for (const path of ["/api/announcements", "/upload/files", "/admin", "/api/upload"]) {
      const ctx = makeCtx(path);
      const next = await run(ctx);
      expect(next).toHaveBeenCalledTimes(1);
      expect(ctx.status).toBeUndefined();
    }
  });

  it("serves /uploads only with the matching x-internal-upload-token", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INTERNAL_UPLOAD_TOKEN", TOKEN);
    const { run } = makeMiddleware();

    const ok = makeCtx("/uploads/report_abc123.pdf", { "x-internal-upload-token": TOKEN });
    expect(await run(ok)).toHaveBeenCalledTimes(1);
    expect(ok.status).toBeUndefined();

    const refused: Record<string, string>[] = [
      {},
      { "x-internal-upload-token": "wrong" },
      { authorization: TOKEN },
    ];
    for (const headers of refused) {
      const ctx = makeCtx("/uploads/report_abc123.pdf", headers);
      const next = await run(ctx);
      expect(next).not.toHaveBeenCalled();
      // 404, never 401: a 401 would confirm that the file exists.
      expect(ctx.status).toBe(404);
    }
  });

  it("gates the traversal shapes that route around the web proxy", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INTERNAL_UPLOAD_TOKEN", TOKEN);
    const { run } = makeMiddleware();
    for (const path of [
      "/api/../uploads/x.pdf",
      "/api/%2e%2e/uploads/x.pdf",
      "/api/..%2fuploads/x.pdf",
    ]) {
      const ctx = makeCtx(path);
      const next = await run(ctx);
      expect(next).not.toHaveBeenCalled();
      expect(ctx.status).toBe(404);
    }
  });

  it("fails closed in production when INTERNAL_UPLOAD_TOKEN is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INTERNAL_UPLOAD_TOKEN", undefined);
    const { run, warn } = makeMiddleware();
    // Even a request that carries SOME token is refused: nothing to compare to.
    const ctx = makeCtx("/uploads/x.pdf", { "x-internal-upload-token": TOKEN });
    const next = await run(ctx);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.status).toBe(404);
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats an empty INTERNAL_UPLOAD_TOKEN like an unset one", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INTERNAL_UPLOAD_TOKEN", "");
    const { run } = makeMiddleware();
    const ctx = makeCtx("/uploads/x.pdf", { "x-internal-upload-token": "" });
    expect(await run(ctx)).not.toHaveBeenCalled();
    expect(ctx.status).toBe(404);
  });

  it("is a no-op outside production when the token is unset, warning once", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("INTERNAL_UPLOAD_TOKEN", undefined);
    const { run, warn } = makeMiddleware();
    for (const path of ["/uploads/a.png", "/api/../uploads/b.png"]) {
      const ctx = makeCtx(path);
      expect(await run(ctx)).toHaveBeenCalledTimes(1);
      expect(ctx.status).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("still enforces a configured token outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("INTERNAL_UPLOAD_TOKEN", TOKEN);
    const { run } = makeMiddleware();
    const ctx = makeCtx("/uploads/x.pdf");
    expect(await run(ctx)).not.toHaveBeenCalled();
    expect(ctx.status).toBe(404);
  });
});
