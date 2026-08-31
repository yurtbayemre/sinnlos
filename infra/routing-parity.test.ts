/**
 * Routing parity between the two reverse-proxy configs (issue #22).
 *
 * The path routing exists TWICE by design: the Traefik labels in
 * docker-compose.traefik.yml are what production (VPS, host Traefik) uses,
 * the Caddyfile is the fallback/standalone profile. §1 of
 * docs/architecture.md declares the two synchronized — but nothing enforced
 * it, and the drift was real: /upload + /email were added to the Traefik
 * labels only (commit 91a305a), so a Caddy deploy would have re-triggered
 * the media-library crash of 2026-08-15 (admin XHRs answered with a
 * sign-in redirect instead of JSON).
 *
 * This test parses BOTH files and asserts:
 *  1. the set of first path segments routed to cms is identical and equals
 *     the canonical list below,
 *  2. a probe table of concrete paths routes identically under each
 *     proxy's REAL matching semantics — including the issue-#21 invariant
 *     that /uploads/* file bytes go to web (session-gated route), while
 *     /upload (media-library admin API) still goes to cms.
 *
 * Matching semantics differ between the proxies and are modelled here:
 *  - Traefik `PathPrefix(`/x`)` is a RAW string prefix — `/email` matches
 *    `/emailXYZ` (verified against the live Traefik 3.7 on 2026-08-17).
 *    `Path(`/x`)` is an exact match. That is why the cms rule needs the
 *    segment-exact `Path(`/upload`) || PathPrefix(`/upload/`)` pair: a bare
 *    `PathPrefix(`/upload`)` would keep swallowing `/uploads`.
 *  - Caddy `path` patterns: a trailing `*` is a raw prefix (`/admin*`),
 *    `/x/*` is a segment prefix, no `*` is an exact match.
 *
 * Known, tolerated edge differences (NOT asserted): bare `/api` or
 * `/emailXYZ` hit cms under Traefik (raw prefix) but web under Caddy —
 * no real endpoint lives on those shapes.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The canonical first-segment list routed to cms. Deliberately duplicated
 * from both config files: the whole point is that a drift in EITHER file
 * fails loudly here instead of surfacing as a broken media library or —
 * worse — anonymously served upload bytes. `uploads` must never appear
 * (issue #21: file bytes are served by the session-gated web route).
 */
const CMS_PREFIXES = [
  "admin",
  "api",
  "content-api",
  "content-manager",
  "content-type-builder",
  "email",
  "i18n",
  "upload",
  "users-permissions",
].sort();

type Backend = "cms" | "web";

/** path → expected backend, identical under BOTH proxies. */
const PROBES: Array<[string, Backend]> = [
  // Issue #21: upload BYTES are session-gated in web…
  ["/uploads/large_photo_abc123.webp", "web"],
  ["/uploads/document_9f8e7d.pdf", "web"],
  ["/uploads", "web"],
  // …while the media-library ADMIN API stays on cms (the 2026-08-15 crash
  // was exactly these XHRs falling through to the web catch-all).
  ["/upload", "cms"],
  ["/upload/files", "cms"],
  ["/upload/actions/bulk-delete", "cms"],
  // Regression for the raw-prefix landmine: an /upload-prefixed segment
  // that is NOT /upload itself belongs to web.
  ["/uploadsomething", "web"],
  // The #22 drift paths.
  ["/email/settings", "cms"],
  // Rest of the Strapi surface.
  ["/api/classifieds", "cms"],
  ["/admin", "cms"],
  ["/admin/plugins", "cms"],
  ["/content-manager/collection-types/api::classified.classified", "cms"],
  ["/content-type-builder/content-types", "cms"],
  ["/users-permissions/roles", "cms"],
  ["/i18n/locales", "cms"],
  ["/content-api/permissions", "cms"],
  // Web app stays on web.
  ["/", "web"],
  ["/sign-in", "web"],
  ["/marketplace", "web"],
  ["/documents", "web"],
  // Live SSE (issue #17/#27): the stream + subscribe endpoints live
  // OUTSIDE /api on purpose so they reach the web catch-all…
  ["/live/stream", "web"],
  ["/live/subscribe", "web"],
  // …while the internal CMS→web emit ingest is EXTERNALLY swallowed by
  // the cms /api rule (no such Strapi route → 404). Only the Docker-
  // internal http://web:3000 path reaches the real handler; this probe
  // pins that external unreachability.
  ["/api/live/emit", "cms"],
];

/**
 * Traversal side channel (issue #21 / review fix K1). Both edge routers match
 * a RAW string prefix, so `/api/../uploads/x` and its percent-encoded twins
 * are routed to cms by the `/api`|`/admin` prefix — around the web session
 * gate — and cms then serves the bytes (koa-static resolves the `..` back into
 * public/uploads). Verified live against prod on 2026-08-17: every shape below
 * returned the %PDF bytes ANONYMOUSLY. Moving `/uploads` to web at the edge
 * therefore does NOT close the hole; the routing-independent cms token gate
 * (apps/cms/src/middlewares/uploads-auth.ts) is the actual protection. This
 * group PINS the leak — that raw-prefix routing genuinely delivers the
 * traversal to cms — so nobody mistakes the edge routing for the fix.
 */
const TRAVERSAL_TO_CMS: string[] = [
  "/api/%2e%2e/uploads/document_9f8e7d.pdf",
  "/api/../uploads/document_9f8e7d.pdf",
  "/admin/%2e%2e/uploads/document_9f8e7d.pdf",
];

type TraefikToken = { kind: "Path" | "PathPrefix"; value: string };

function readInfraFile(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

function parseTraefikCmsTokens(): TraefikToken[] {
  const source = readFileSync(new URL("./docker-compose.traefik.yml", import.meta.url), "utf8");
  const ruleLine = source
    .split("\n")
    .find((line) => line.includes("traefik.http.routers.sinnlos-cms.rule="));
  expect(ruleLine, "sinnlos-cms rule line in docker-compose.traefik.yml").toBeDefined();
  const tokens: TraefikToken[] = [];
  for (const match of ruleLine!.matchAll(/(PathPrefix|Path)\(`([^`]+)`\)/g)) {
    tokens.push({ kind: match[1] as TraefikToken["kind"], value: match[2] });
  }
  expect(tokens.length, "matcher tokens in the sinnlos-cms rule").toBeGreaterThan(0);
  return tokens;
}

function parseCaddyStrapiPatterns(): string[] {
  const source = readInfraFile("Caddyfile");
  const match = source.match(/^\s*@strapi\s+path\s+(.+)$/m);
  expect(match, "@strapi path matcher line in Caddyfile").not.toBeNull();
  const patterns = match![1].trim().split(/\s+/);
  expect(patterns.length, "path patterns on the @strapi matcher").toBeGreaterThan(0);
  return patterns;
}

/** Traefik v3 semantics: Path = exact, PathPrefix = raw string prefix. */
function traefikSendsToCms(tokens: TraefikToken[], path: string): boolean {
  return tokens.some((token) =>
    token.kind === "Path" ? path === token.value : path.startsWith(token.value),
  );
}

/** Caddy path matcher: trailing `*` = raw prefix, otherwise exact match. */
function caddySendsToCms(patterns: string[], path: string): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern,
  );
}

/** "/api/*" → "api", "/admin*" → "admin", "/upload" → "upload". */
function firstSegment(pattern: string): string {
  return pattern.replace(/^\//, "").split("/")[0].replace(/\*$/, "");
}

describe("Traefik/Caddy routing parity (issue #22)", () => {
  const traefikTokens = parseTraefikCmsTokens();
  const caddyPatterns = parseCaddyStrapiPatterns();

  it("Traefik cms router covers exactly the canonical prefixes", () => {
    const segments = [...new Set(traefikTokens.map((t) => firstSegment(t.value)))].sort();
    expect(segments).toEqual(CMS_PREFIXES);
  });

  it("Caddy @strapi matcher covers exactly the canonical prefixes", () => {
    const segments = [...new Set(caddyPatterns.map(firstSegment))].sort();
    expect(segments).toEqual(CMS_PREFIXES);
  });

  it("neither proxy routes /uploads (file bytes) to cms — issue #21", () => {
    expect(traefikTokens.map((t) => firstSegment(t.value))).not.toContain("uploads");
    expect(caddyPatterns.map(firstSegment)).not.toContain("uploads");
  });

  it.each(PROBES)("routes %s to %s under BOTH proxies", (path, backend) => {
    const wantCms = backend === "cms";
    expect(
      traefikSendsToCms(traefikTokens, path),
      `Traefik should send ${path} to ${backend}`,
    ).toBe(wantCms);
    expect(caddySendsToCms(caddyPatterns, path), `Caddy should send ${path} to ${backend}`).toBe(
      wantCms,
    );
  });

  // Invariant: raw-prefix routing lets `..` traversal reach cms, so the /uploads
  // protection MUST be cms-side (the token gate, fix K1) — the edge routing
  // alone is NOT sufficient. See TRAVERSAL_TO_CMS above.
  it.each(TRAVERSAL_TO_CMS)(
    "raw-prefix routing delivers traversal %s to cms — protection must be cms-side (K1)",
    (path) => {
      expect(traefikSendsToCms(traefikTokens, path), `Traefik routes ${path} to cms`).toBe(true);
      expect(caddySendsToCms(caddyPatterns, path), `Caddy routes ${path} to cms`).toBe(true);
    },
  );
});
