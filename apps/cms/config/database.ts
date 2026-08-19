import path from "path";

type Env = ((key: string, def?: unknown) => any) & {
  int: (key: string, def?: number) => number;
  bool: (key: string, def?: boolean) => boolean;
  array: (key: string, def?: string[]) => string[];
};

export default ({ env }: { env: Env }) => {
  const client = env("DATABASE_CLIENT", "postgres");

  const connections = {
    postgres: {
      connection: {
        connectionString: env("DATABASE_URL"),
        host: env("DATABASE_HOST", "localhost"),
        port: env.int("DATABASE_PORT", 5432),
        database: env("DATABASE_NAME", "sinnlos"),
        user: env("DATABASE_USERNAME", "sinnlos"),
        password: env("DATABASE_PASSWORD"),
        ssl: env.bool("DATABASE_SSL", false) && {
          key: env("DATABASE_SSL_KEY", undefined),
          cert: env("DATABASE_SSL_CERT", undefined),
          ca: env("DATABASE_SSL_CA", undefined),
          capath: env("DATABASE_SSL_CAPATH", undefined),
          cipher: env("DATABASE_SSL_CIPHER", undefined),
          rejectUnauthorized: env.bool("DATABASE_SSL_REJECT_UNAUTHORIZED", true),
        },
        schema: env("DATABASE_SCHEMA", "public"),
      },
      pool: { min: env.int("DATABASE_POOL_MIN", 2), max: env.int("DATABASE_POOL_MAX", 10) },
    },
    sqlite: {
      connection: {
        filename: path.join(
          __dirname,
          "..",
          "..",
          env("DATABASE_FILENAME", ".tmp/data.db"),
        ),
      },
      useNullAsDefault: true,
    },
  } as const;

  return {
    connection: {
      client,
      ...(connections as any)[client],
      acquireConnectionTimeout: env.int("DATABASE_CONNECTION_TIMEOUT", 60000),
    },
    settings: {
      // Destructive schema sync is OFF (#25): @strapi/database defaults
      // forceMigration to TRUE, i.e. on boot it DROPS columns/tables/indexes
      // that a removed attribute leaves behind. We keep the orphaned
      // `target_id` columns in comments+reactions as the rollback anchor for
      // pre-#25 images, so drops must not happen implicitly. Additive sync
      // (new columns/tables/indexes) is unaffected by this flag.
      // The deliberate cleanup later: one-off boot with
      // DATABASE_FORCE_MIGRATION=true after pg backup (drops ALL orphaned
      // tracked columns), or manual ALTER TABLE — see docs/architecture.md
      // §5.27.
      forceMigration: env.bool("DATABASE_FORCE_MIGRATION", false),
    },
  };
};
