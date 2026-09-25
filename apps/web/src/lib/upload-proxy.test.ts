import { describe, expect, it } from "vitest";
import {
  downstreamResponseHeaders,
  FORWARD_REQUEST_HEADERS,
  FORWARD_RESPONSE_HEADERS,
  isValidUploadPath,
  SEGMENT_RE,
  UPLOAD_TOKEN_HEADER,
  upstreamRequestHeaders,
  upstreamUploadUrl,
} from "./upload-proxy";

/**
 * The pure parts of the session-gated /uploads byte proxy (issue #21, S06).
 * The route itself (auth() check, fetch, streaming) is not exercised here.
 * Pinned:
 *   1. only hash-style file segments reach cms — traversal, encoded slashes,
 *      dot-files and empty segments are a 404 before any upstream call,
 *   2. request headers are an allowlist: the browser's cookie/authorization
 *      never reach cms, and a client-supplied internal token is dropped,
 *   3. identity encoding is always requested (Content-Length is forwarded),
 *   4. the internal token header name matches the cms uploads-auth gate,
 *   5. response headers are an allowlist and caching is always `private`.
 */

describe("isValidUploadPath / SEGMENT_RE", () => {
  it("accepts Strapi's hash-based file names", () => {
    for (const path of [
      ["report_abc123.pdf"],
      ["thumbnail_team-photo_4f2a9c.jpg"],
      // A stem core slugs to "" (写真.png, 🙂.png): C2-UPLOAD-EMPTY-SLUG.
      ["_3f9a1c0b2e.png"],
      ["thumbnail__3f9a1c0b2e.png"],
      ["_x.pdf"],
      ["large_Logo_9A8B.PNG"],
      ["a"],
      ["sub", "x.png"],
    ]) {
      expect(isValidUploadPath(path)).toBe(true);
    }
  });

  it("rejects traversal, dot-files, separators and empty segments", () => {
    for (const path of [
      [".."],
      ["."],
      ["..", "x.pdf"],
      [".env"],
      ["a/b.pdf"],
      ["..%2fx.pdf"],
      ["a%2fb.pdf"],
      ["a\\b.pdf"],
      [""],
      ["x.pdf", ""],
      ["-x.pdf"],
      ["_", ".."],
      ["._x.pdf"],
      ["a b.pdf"],
      ["ä.png"],
      ["x.pdf\n"],
      ["x.pdf?download=1"],
    ]) {
      expect(isValidUploadPath(path)).toBe(false);
    }
  });

  it("rejects a missing, empty or non-array param", () => {
    for (const path of [undefined, null, [], "x.pdf", { 0: "x.pdf", length: 1 }, [42]]) {
      expect(isValidUploadPath(path)).toBe(false);
    }
  });

  it("anchors the segment regex at both ends", () => {
    expect(SEGMENT_RE.test("ok.pdf")).toBe(true);
    expect(SEGMENT_RE.test("ok.pdf/..")).toBe(false);
    expect(SEGMENT_RE.test("../ok.pdf")).toBe(false);
  });
});

describe("upstreamUploadUrl", () => {
  it("targets cms /uploads with each segment encoded on its own", () => {
    expect(upstreamUploadUrl("http://cms:1337", ["report_abc123.pdf"])).toBe(
      "http://cms:1337/uploads/report_abc123.pdf",
    );
    expect(upstreamUploadUrl("http://cms:1337", ["sub", "x.png"])).toBe(
      "http://cms:1337/uploads/sub/x.png",
    );
    // Defence in depth — a segment can never smuggle a separator.
    expect(upstreamUploadUrl("http://cms:1337", ["a/b c"])).toBe(
      "http://cms:1337/uploads/a%2Fb%20c",
    );
  });
});

describe("upstreamRequestHeaders", () => {
  const browser = new Headers({
    range: "bytes=0-1023",
    "if-none-match": '"etag-1"',
    "if-modified-since": "Tue, 01 Sep 2026 10:00:00 GMT",
    cookie: "authjs.session-token=secret",
    authorization: "Bearer user-jwt",
    "x-forwarded-for": "203.0.113.7",
    "accept-encoding": "gzip, br",
    [UPLOAD_TOKEN_HEADER]: "client-supplied",
  });

  it("forwards only the conditional/range allowlist", () => {
    expect([...FORWARD_REQUEST_HEADERS]).toEqual(["range", "if-none-match", "if-modified-since"]);
    const out = upstreamRequestHeaders(browser, "server-token");
    expect(out.get("range")).toBe("bytes=0-1023");
    expect(out.get("if-none-match")).toBe('"etag-1"');
    expect(out.get("if-modified-since")).toBe("Tue, 01 Sep 2026 10:00:00 GMT");
    expect(out.get("cookie")).toBeNull();
    expect(out.get("authorization")).toBeNull();
    expect(out.get("x-forwarded-for")).toBeNull();
    expect([...out.keys()].sort()).toEqual(
      [
        "accept-encoding",
        "if-modified-since",
        "if-none-match",
        "range",
        UPLOAD_TOKEN_HEADER,
      ].sort(),
    );
  });

  it("always asks cms for identity encoding", () => {
    expect(upstreamRequestHeaders(browser, "server-token").get("accept-encoding")).toBe("identity");
    expect(upstreamRequestHeaders(new Headers(), undefined).get("accept-encoding")).toBe(
      "identity",
    );
  });

  it("sends the server's internal token, never the client's", () => {
    expect(upstreamRequestHeaders(browser, "server-token").get(UPLOAD_TOKEN_HEADER)).toBe(
      "server-token",
    );
  });

  it("omits the token header when no token is configured", () => {
    expect(upstreamRequestHeaders(browser, undefined).has(UPLOAD_TOKEN_HEADER)).toBe(false);
    expect(upstreamRequestHeaders(browser, "").has(UPLOAD_TOKEN_HEADER)).toBe(false);
  });

  it("uses the header name the cms uploads-auth gate reads", () => {
    expect(UPLOAD_TOKEN_HEADER).toBe("x-internal-upload-token");
  });
});

describe("downstreamResponseHeaders", () => {
  it("mirrors only the allowlist and forces private caching", () => {
    const upstream = new Headers({
      "content-type": "application/pdf",
      "content-length": "1234",
      "content-range": "bytes 0-1023/1234",
      "accept-ranges": "bytes",
      etag: '"etag-1"',
      "last-modified": "Tue, 01 Sep 2026 10:00:00 GMT",
      "cache-control": "public, max-age=31536000",
      "content-encoding": "gzip",
      "set-cookie": "koa.sess=abc",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
      "x-powered-by": "Strapi",
    });
    const out = downstreamResponseHeaders(upstream);
    for (const name of FORWARD_RESPONSE_HEADERS) {
      expect(out.get(name)).toBe(upstream.get(name));
    }
    expect(out.get("cache-control")).toBe("private, max-age=3600");
    expect([...out.keys()].sort()).toEqual([...FORWARD_RESPONSE_HEADERS, "cache-control"].sort());
  });

  it("sets private caching even when upstream sends no headers", () => {
    const out = downstreamResponseHeaders(new Headers());
    expect([...out.entries()]).toEqual([["cache-control", "private, max-age=3600"]]);
  });
});
