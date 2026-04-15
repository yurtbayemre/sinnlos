type Env = ((key: string, def?: unknown) => any) & {
  int: (key: string, def?: number) => number;
  bool: (key: string, def?: boolean) => boolean;
  array: (key: string, def?: string[]) => string[];
};

export default ({ env }: { env: Env }) => ({
  host: env("HOST", "0.0.0.0"),
  port: env.int("PORT", 1337),
  app: {
    keys: env.array("APP_KEYS"),
  },
  url: env("PUBLIC_URL", "http://localhost:1337"),
  proxy: true,
});
