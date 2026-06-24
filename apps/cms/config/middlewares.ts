type Env = ((key: string, def?: unknown) => any) & {
  int: (key: string, def?: number) => number;
  bool: (key: string, def?: boolean) => boolean;
  array: (key: string, def?: string[]) => string[];
};

export default ({ env }: { env: Env }) => {
  // Concrete origins the Strapi admin panel actually loads from, instead of
  // a blanket `https:`. `self` covers the admin bundle + uploaded media that
  // Strapi serves locally; PUBLIC_URL covers media when served under the
  // proxied public origin; market-assets.strapi.io serves the marketplace
  // plugin thumbnails (kept while the marketplace UI may still render).
  const publicUrl = env("PUBLIC_URL", "http://localhost:1337");

  return [
    "strapi::logger",
    "strapi::errors",
    {
      name: "strapi::security",
      config: {
        contentSecurityPolicy: {
          useDefaults: true,
          directives: {
            "connect-src": ["'self'", publicUrl],
            "img-src": ["'self'", "data:", "blob:", publicUrl, "market-assets.strapi.io"],
            "media-src": ["'self'", "data:", "blob:", publicUrl],
            upgradeInsecureRequests: null,
          },
        },
      },
    },
    {
      name: "strapi::cors",
      config: {
        origin: (process.env.CORS_ORIGIN || "http://localhost:3000").split(","),
        headers: ["Content-Type", "Authorization", "Origin", "Accept", "X-Requested-With"],
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
        credentials: true,
      },
    },
    "strapi::poweredBy",
    "strapi::query",
    "strapi::body",
    "strapi::session",
    "strapi::favicon",
    "strapi::public",
  ];
};
