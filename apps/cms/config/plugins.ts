/**
 * Strapi plugin configuration.
 *
 * The users-permissions plugin ships with a built-in Microsoft provider
 * (login.microsoftonline.com). We enable it here and provide redirect URIs
 * that point at Strapi's connect callback route. The provider is
 * auto-disabled when MS_CLIENT_ID is unset, so standalone (local
 * username/password) deployments don't advertise a dead provider.
 *
 * Entra ID (Azure AD) app registration:
 *   - Redirect URI: ${PUBLIC_URL}/api/connect/microsoft/callback
 *   - API permissions: openid, profile, email, User.Read, GroupMember.Read.All
 *     GroupMember.Read.All is a delegated Graph permission that REQUIRES
 *     tenant admin consent. Without it (in the scope below AND consented in
 *     the app registration) `/me/memberOf` returns 403, the group-based
 *     role mapping (config/ms-role-map.ts) never matches, and every
 *     Microsoft login falls back to the `member` role.
 */
type Env = ((key: string, def?: unknown) => any) & {
  int: (key: string, def?: number) => number;
  bool: (key: string, def?: boolean) => boolean;
  array: (key: string, def?: string[]) => string[];
};

export default ({ env }: { env: Env }) => ({
  "users-permissions": {
    config: {
      jwt: {
        expiresIn: "7d",
      },
      jwtSecret: env("JWT_SECRET"),
      providers: {
        microsoft: {
          enabled: !!env("MS_CLIENT_ID", ""),
          icon: "microsoft",
          key: env("MS_CLIENT_ID", ""),
          secret: env("MS_CLIENT_SECRET", ""),
          callback: `${env("PUBLIC_URL", "http://localhost:1337")}/api/connect/microsoft/callback`,
          scope: ["openid", "profile", "email", "User.Read", "GroupMember.Read.All"],
          tenant: env("MS_TENANT_ID", "common"),
        },
      },
      register: {
        allowedFields: ["microsoftOid", "displayName", "jobTitle", "avatar"],
      },
    },
  },
  /**
   * Upload hardening (marketplace ads opened the content-api upload route
   * to regular employees for the first time):
   *
   *  - `sizeLimit` caps EVERY upload (admin panel included) at 50 MB —
   *    down from Strapi's 1 GB default. The strapi::body formidable limit
   *    in config/middlewares.ts is kept consistent with this value.
   *    Employee uploads via POST /api/upload are additionally capped at
   *    5 MB per image in src/extensions/upload/strapi-server.ts.
   *  - `security.deniedTypes` is the native magic-byte MIME check (Strapi
   *    >= 5.31, checks real file signatures via file-type, not extensions).
   *    It runs for admin AND content-api uploads. SVG is denied globally:
   *    it is a stored-XSS vector (script/event handlers in XML; Strapi
   *    upload XSS history: CVE-2022-32114). Executables/HTML likewise.
   *    The content-api route is further restricted to a JPEG/PNG/WebP
   *    allowlist in the upload extension; this deny list is the backstop
   *    that also covers admin-panel uploads.
   */
  upload: {
    config: {
      sizeLimit: 50 * 1024 * 1024,
      security: {
        deniedTypes: [
          "image/svg+xml",
          "text/html",
          "application/xhtml+xml",
          "text/javascript",
          "application/javascript",
          "application/x-sh",
          "application/x-dosexec",
          "application/x-msdownload",
          "application/x-executable",
          "application/x-elf",
          "application/x-mach-binary",
          "application/vnd.microsoft.portable-executable",
        ],
      },
    },
  },
});
