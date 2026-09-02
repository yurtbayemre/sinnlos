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
  // Don't advertise the framework in responses.
  poweredByHeader: false,
  // NOTE: no `images` config — nothing renders through next/image. Avatars
  // and document links use plain <img>/<a> (radix Avatar's <img>), which
  // bypass the image optimizer, so `images.remotePatterns` had no effect.
  // The old wildcard `https://**` pattern was also unnecessarily broad. If
  // a next/image consumer is ever added, scope remotePatterns to the Strapi
  // host (STRAPI_PUBLIC_URL, e.g. sinnlos.yurtbay.dev) plus localhost.
  experimental: {
    // Marketplace ad photos travel through a Server Action (FormData →
    // Strapi /api/upload with the session JWT; the browser never sees the
    // JWT). Default limit is 1 MB — allow 4 images x 5 MB plus form
    // overhead. Strapi enforces the real per-file limits server-side.
    serverActions: {
      bodySizeLimit: "22mb",
    },
  },
};

export default withNextIntl(nextConfig);
