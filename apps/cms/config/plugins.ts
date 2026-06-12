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
