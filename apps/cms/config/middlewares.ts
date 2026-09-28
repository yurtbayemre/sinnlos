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
  // The web origins allowed to call the API from a browser: comma-separated
  // (compose passes WEB_PUBLIC_URL). Unset or empty means the local dev web.
  const corsOrigins = String(env("CORS_ORIGIN", "") || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

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
        origin: corsOrigins,
        headers: ["Content-Type", "Authorization", "Origin", "Accept", "X-Requested-With"],
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
        credentials: true,
      },
    },
    // No strapi::poweredBy: the X-Powered-By header only advertised the
    // framework to every client.
    "strapi::query",
    {
      // Cap multipart bodies at the same 50 MB as the upload plugin's
      // sizeLimit (config/plugins.ts) — formidable's default would accept
      // 200 MB and only fail later in the provider. Both limits must be
      // kept in sync.
      name: "strapi::body",
      config: {
        formidable: { maxFileSize: 50 * 1024 * 1024 },
      },
    },
    "strapi::session",
    "strapi::favicon",
    // Routing-independent gate on the /uploads bytes (issue #21, K1). It must
    // stay a GLOBAL middleware (listed here, not a route middleware): that is
    // what lets it see `/api/../uploads/x` before any route handler, including
    // the koa-static route that would resolve it back into public/uploads.
    // Its position in this list does not matter: strapi::public registers
    // routes instead of a middleware, and Strapi mounts all routes after all
    // global middlewares (pinned in src/framework-contract.test.ts). See
    // src/middlewares/uploads-auth.ts.
    "global::uploads-auth",
    // Case-variant / encoded spellings of Strapi's own /api/auth/* routes get
    // a 404 (D-EDGE-01): Traefik's PathPrefix(`/api/auth`) is case-sensitive,
    // Strapi's router is not, so `/api/Auth/local` would otherwise reach the
    // local login past the web rate limiter. See
    // src/middlewares/auth-path-guard.ts. Global, like uploads-auth.
    "global::auth-path-guard",
    // Contact fields (email/phone/hireDate/officeLocation/microsoftOid) are
    // not filterable, sortable or `_q`-searchable for non-staff callers
    // (FX22): a 400 `Invalid key`. The query side of the output sanitizer in
    // src/index.ts. A global middleware only by registration: its factory
    // wraps strapi.contentAPI.validate.query once at boot (the per-request
    // chain runs before authentication and cannot see the role) and returns
    // a pass-through, so its position here does not matter. See
    // src/middlewares/sensitive-query-guard.ts.
    "global::sensitive-query-guard",
    "strapi::public",
  ];
};
