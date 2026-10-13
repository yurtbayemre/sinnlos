import path from "path";
import { fileURLToPath } from "url";
import createNextIntlPlugin from "next-intl/plugin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Route strings in <Link>/router.push are type-checked at build time
  // (issue #32) — a renamed route fails the typecheck instead of 404ing.
  typedRoutes: true,
  outputFileTracingRoot: path.join(__dirname, "../../"),
  devIndicators: false,
  // Since Next 16.3, `next dev` writes apps/web/AGENTS.md and CLAUDE.md
  // when it detects an AI coding agent (config-shared.d.ts `agentRules`,
  // gated in server/lib/start-server.js). They would land as untracked
  // files in every checkout that runs the dev server; the repo keeps its
  // own docs instead.
  agentRules: false,
  // Don't advertise the framework in responses.
  poweredByHeader: false,
  // NOTE: no `images` config — nothing renders through next/image. Avatars
  // and document links use plain <img>/<a> (radix Avatar's <img>), which
  // bypass the image optimizer, so `images.remotePatterns` had no effect.
  // The old wildcard `https://**` pattern was also unnecessarily broad. If
  // a next/image consumer is ever added, scope remotePatterns to the Strapi
  // host (STRAPI_PUBLIC_URL, e.g. sinnlos.yurtbay.dev) plus localhost.
  experimental: {
    // Uploads travel through Server Actions (FormData → Strapi /api/upload
    // with the session JWT; the browser never sees the JWT): marketplace ad
    // photos (4 images x 5 MB) and, since batch 16, one document file of up
    // to 20 MB (PDF and Office; @sinnlos/domain DOCUMENT_MAX_BYTES). The
    // default limit is 1 MB; 22 MB leaves room for the multipart overhead.
    // Strapi enforces the real per-file limits server-side (decision 06
    // §E1, §E8).
    serverActions: {
      bodySizeLimit: "22mb",
    },
    // The proxy (src/proxy.ts matches every path) buffers each request body
    // up to this size before the action reads it; Next 16.4's default is
    // 10 MB, and a larger body reaches the action CUT SHORT (a warning in
    // the log, a broken multipart form for the user). Kept equal to the
    // action limit above, so both edges let the same body through (batch
    // 16 plan S8; next.config.test.ts pins the pair).
    proxyClientMaxBodySize: "22mb",
  },
};

export default withNextIntl(nextConfig);
