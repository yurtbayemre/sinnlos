import path from "path";
import { fileURLToPath } from "url";
import createNextIntlPlugin from "next-intl/plugin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
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
};

export default withNextIntl(nextConfig);
