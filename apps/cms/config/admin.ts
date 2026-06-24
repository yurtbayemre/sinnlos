type Env = ((key: string, def?: unknown) => any) & {
  int: (key: string, def?: number) => number;
  bool: (key: string, def?: boolean) => boolean;
  array: (key: string, def?: string[]) => string[];
};

export default ({ env }: { env: Env }) => ({
  auth: {
    secret: env("ADMIN_JWT_SECRET"),
  },
  apiToken: {
    salt: env("API_TOKEN_SALT"),
  },
  transfer: {
    token: {
      salt: env("TRANSFER_TOKEN_SALT"),
    },
  },
  secrets: {
    encryptionKey: env("ENCRYPTION_KEY"),
  },
  flags: {
    // NPS in-admin survey and the EE/marketplace promotion are unused on this
    // intranet; default them off so they stay disabled unless explicitly
    // re-enabled via env.
    nps: env.bool("FLAG_NPS", false),
    promoteEE: env.bool("FLAG_PROMOTE_EE", false),
  },
});
