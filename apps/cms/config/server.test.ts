import { describe, expect, it } from "vitest";
import serverConfig from "./server";

/**
 * Pins FX11: Strapi 5.49 builds its Koa app with
 * `proxy: strapi.config.get('server.proxy.koa')` (@strapi/core
 * dist/services/server/index.js:23). The v4 form `proxy: true` has no `koa`
 * key, so X-Forwarded-For was ignored and every local sign-in shared the web
 * container's throttle bucket (verified on a booted 5.49: a second client IP
 * got 429 with `proxy: true`, its own bucket with `proxy: { koa: true }`).
 */
type EnvStore = Record<string, string>;

/** Minimal stand-in for Strapi's env helper (only what server.ts uses). */
const makeEnv = (store: EnvStore = {}) => {
  const env = (key: string, def?: unknown) => store[key] ?? def;
  env.int = (key: string, def?: number) =>
    key in store ? parseInt(store[key], 10) : (def as number);
  env.bool = (key: string, def?: boolean) =>
    key in store ? store[key] === "true" : (def as boolean);
  env.array = (key: string, def?: string[]) =>
    key in store ? store[key].split(",") : (def as string[]);
  return env;
};

describe("config/server", () => {
  it("trusts the proxy headers under the key Strapi 5 reads (server.proxy.koa)", () => {
    const config = serverConfig({ env: makeEnv() });
    expect(config.proxy).toEqual({ koa: true });
  });
});
