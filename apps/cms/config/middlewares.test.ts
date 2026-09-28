import { describe, expect, it } from "vitest";
import middlewaresConfig from "./middlewares";

/**
 * config/middlewares.ts hygiene (roadmap B05): the CORS origins come from
 * Strapi's env helper, and no middleware advertises the framework. The
 * global guards' registration is pinned in
 * src/middlewares/sensitive-query-guard.test.ts.
 */

type EnvStore = Record<string, string>;

/** Minimal stand-in for Strapi's env helper (what middlewares.ts uses). */
const makeEnv = (store: EnvStore = {}) =>
  Object.assign((key: string, def?: unknown) => store[key] ?? def, {
    int: (key: string, def?: number) => (key in store ? parseInt(store[key], 10) : (def as number)),
    bool: (key: string, def?: boolean) => (key in store ? store[key] === "true" : (def as boolean)),
    array: (key: string, def?: string[]) => (key in store ? store[key].split(",") : (def as string[])),
  });

type Entry = string | { name: string; config?: Record<string, unknown> };

const entries = (store?: EnvStore): Entry[] => middlewaresConfig({ env: makeEnv(store) });
const names = (store?: EnvStore) =>
  entries(store).map((entry) => (typeof entry === "string" ? entry : entry.name));
const corsOrigin = (store?: EnvStore) => {
  const cors = entries(store).find(
    (entry): entry is Exclude<Entry, string> =>
      typeof entry !== "string" && entry.name === "strapi::cors",
  );
  return cors?.config?.origin;
};

describe("config/middlewares.ts (B05)", () => {
  it("does not send X-Powered-By (no strapi::poweredBy)", () => {
    expect(names()).not.toContain("strapi::poweredBy");
    expect(names()).toContain("strapi::security");
  });

  it("reads the CORS origins through env(), comma-separated and trimmed", () => {
    expect(corsOrigin({ CORS_ORIGIN: "https://intranet.example.com" })).toEqual([
      "https://intranet.example.com",
    ]);
    expect(corsOrigin({ CORS_ORIGIN: "https://a.example.com, https://b.example.com," })).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });

  it("falls back to the local web origin when CORS_ORIGIN is unset or empty", () => {
    expect(corsOrigin()).toEqual(["http://localhost:3000"]);
    expect(corsOrigin({ CORS_ORIGIN: "" })).toEqual(["http://localhost:3000"]);
  });
});
