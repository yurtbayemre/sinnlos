import { ALLOWED_QUERY_PARAM_KEYS, sanitize } from "@strapi/utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pickContentApiQueryParams } from "./rest-query-params";

/**
 * Final review C1-RAW-WHERE. The wiring (the pick runs inside the
 * sanitize.query wrapper for every caller) is pinned in
 * index.register.test.ts; this file pins the pick itself and the core
 * behaviour that makes it necessary.
 */

/** The model type the core sanitizers expect (a full Strapi schema). */
type CoreModel = ReturnType<Parameters<typeof sanitize.createAPISanitizers>[0]["getModel"]>;

const userSchema = {
  uid: "plugin::users-permissions.user",
  modelType: "contentType",
  kind: "collectionType",
  attributes: {
    username: { type: "string" },
    password: { type: "password", private: true },
    resetPasswordToken: { type: "string", private: true },
  },
};

describe("pickContentApiQueryParams", () => {
  it("keeps every core content-api query key untouched", () => {
    const query = Object.fromEntries(ALLOWED_QUERY_PARAM_KEYS.map((key) => [key, `v-${key}`]));
    expect(pickContentApiQueryParams(query)).toEqual(query);
  });

  it("drops the query-builder keys and any other unknown root key", () => {
    const out = pickContentApiQueryParams({
      filters: { username: "ada" },
      where: { password: { $startsWith: "$2a$" } },
      select: ["password"],
      orderBy: { resetPasswordToken: "asc" },
      groupBy: ["password"],
      offset: 5,
      publicationState: "preview",
    });
    expect(out).toEqual({ filters: { username: "ada" } });
  });

  it("keeps the extra query keys the route declares, and only those", () => {
    const route = { request: { query: { window: {}, days: {} } } };
    expect(pickContentApiQueryParams({ window: "7", days: "30", where: {} }, route)).toEqual({
      window: "7",
      days: "30",
    });
    expect(pickContentApiQueryParams({ window: "7" }, { request: null })).toEqual({});
    expect(pickContentApiQueryParams({ window: "7" }, null)).toEqual({});
  });

  it("returns a copy, never the input", () => {
    const query = { filters: { username: "ada" } };
    const out = pickContentApiQueryParams(query);
    expect(out).not.toBe(query);
    expect(out.filters).toBe(query.filters);
  });
});

describe("why: the core sanitizer keeps raw DB keys without strictParams (@strapi/utils 5.49)", () => {
  // isPrivateAttribute reads `strapi.config` for api.responses.privateAttributes.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const coreSanitizeQuery = (query: Record<string, unknown>) => {
    vi.stubGlobal("strapi", {
      config: { get: (_key: string, fallback?: unknown) => fallback },
    });
    // The slice above is all the query walk reads; a full schema is not needed.
    const model = userSchema as unknown as CoreModel;
    const sanitizers = sanitize.createAPISanitizers({ getModel: () => model });
    return sanitizers.query(query, model, {}) as Promise<Record<string, unknown>>;
  };

  it("strips a private field from filters but hands `where`/`orderBy` through verbatim", async () => {
    const raw = {
      filters: { password: { $startsWith: "$2a$" }, username: "ada" },
      where: { resetPasswordToken: { $startsWith: "a1" } },
      orderBy: { password: "asc" },
    };
    const core = await coreSanitizeQuery(raw);
    // The trap: filters are cleaned, the query-builder keys are not.
    expect(core).toEqual({
      filters: { username: "ada" },
      where: raw.where,
      orderBy: raw.orderBy,
    });
    // The pick closes it.
    expect(pickContentApiQueryParams(core)).toEqual({ filters: { username: "ada" } });
  });
});
