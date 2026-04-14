/**
 * Strapi plugin configuration.
 *
 * The users-permissions plugin ships with a built-in Microsoft provider
 * (login.microsoftonline.com). We enable it here and provide redirect URIs
 * that point at Strapi's connect callback route.
 *
 * Entra ID (Azure AD) app registration:
 *   - Redirect URI: ${PUBLIC_URL}/api/connect/microsoft/callback
 *   - API permissions: openid, profile, email, User.Read, GroupMember.Read.All
 */
export default ({ env }: { env: (key: string, def?: unknown) => any }) => ({
  "users-permissions": {
    config: {
      jwt: {
        expiresIn: "7d",
      },
      jwtSecret: env("JWT_SECRET"),
      providers: {
        microsoft: {
          enabled: true,
          icon: "microsoft",
          key: env("MS_CLIENT_ID", ""),
          secret: env("MS_CLIENT_SECRET", ""),
          callback: `${env("PUBLIC_URL", "http://localhost:1337")}/api/connect/microsoft/callback`,
          scope: ["openid", "profile", "email", "User.Read"],
          tenant: env("MS_TENANT_ID", "common"),
        },
      },
      register: {
        allowedFields: ["microsoftOid", "displayName", "jobTitle", "avatar"],
      },
    },
  },
});
