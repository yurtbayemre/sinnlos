/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Hide the dev-only route/build indicator overlay (the lightning bolt in
  // the bottom-left corner). It's useless for normal preview work.
  devIndicators: {
    appIsrStatus: false,
    buildActivity: false,
  },
  images: {
    remotePatterns: [
      { protocol: "http", hostname: "localhost" },
      { protocol: "https", hostname: "**" },
    ],
  },
  experimental: {
    typedRoutes: false,
  },
};

export default nextConfig;
