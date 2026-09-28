import { describe, expect, it, vi } from "vitest";
import {
  BIND_HEADROOM,
  BIND_LIMITS,
  boundedIdFilter,
  fitsBindLimit,
  forcePublishedStatus,
  getMutableQuery,
  maxBoundValues,
  narrowFilters,
  restrictiveIdFilter,
} from "./policy-query";

/**
 * Guards the sanitize fail-open fix: @strapi/utils' defaultSanitizeFilters
 * strips empty array operands, so `{ id: { $in: [] } }` would degrade to
 * `{ id: {} }` (no filter at all). The empty case must therefore be a
 * scalar, non-empty operand that can never match.
 */
describe("restrictiveIdFilter", () => {
  it("keeps $in for a non-empty id list", () => {
    expect(restrictiveIdFilter([3, 7])).toEqual({ id: { $in: [3, 7] } });
  });

  it("emits a sanitize-proof scalar clause for an empty id list", () => {
    const filter = restrictiveIdFilter([]);
    expect(filter).toEqual({ id: { $eq: -1 } });
    // Must NOT be an array operand — sanitizeQuery removes empty arrays.
    expect(Array.isArray((filter.id as Record<string, unknown>).$eq)).toBe(false);
  });
});

/**
 * Guards the draft-read fix: the id-based policies resolve their ids via
 * `strapi.db.query`, which returns draft AND published rows, so the
 * publication state is decided solely by the client-controllable `status`
 * param (validateQuery allows it, sanitizeQuery passes it through, and the
 * core service merges it over its own `status: 'published'` default).
 */
describe("forcePublishedStatus", () => {
  it("overwrites a client-supplied status=draft", () => {
    const query: Record<string, any> = { status: "draft", filters: { id: { $in: [1] } } };
    forcePublishedStatus(query);
    expect(query.status).toBe("published");
    // The filter the policy already injected must survive untouched.
    expect(query.filters).toEqual({ id: { $in: [1] } });
  });

  it("sets the status when the client sent none", () => {
    const query: Record<string, any> = {};
    forcePublishedStatus(query);
    expect(query.status).toBe("published");
  });

  it("deletes the legacy v4 publicationState param", () => {
    const query: Record<string, any> = { publicationState: "preview" };
    forcePublishedStatus(query);
    expect("publicationState" in query).toBe(false);
  });

  it("deletes the publicationFilter and hasPublishedVersion params", () => {
    // Both are content-api keys the document service turns into a
    // publication-cohort filter; non-bypass readers must not steer it.
    const query: Record<string, unknown> = {
      status: "draft",
      publicationFilter: "modified",
      hasPublishedVersion: "true",
      filters: { id: { $in: [1] } },
    };
    forcePublishedStatus(query);
    expect(query.status).toBe("published");
    expect("publicationFilter" in query).toBe(false);
    expect("hasPublishedVersion" in query).toBe(false);
    expect(query.filters).toEqual({ id: { $in: [1] } });
  });

  it("mutates in place — the controller reads the SAME object", () => {
    // Returning a copy would be the policyContext.query no-op all over
    // again: sanitizeQuery/validateQuery read `ctx.request.query`.
    const query: Record<string, any> = { status: "draft" };
    const same = query;
    forcePublishedStatus(query);
    expect(same.status).toBe("published");
  });
});

/**
 * Guards the policy-context no-op fix (issue #24, trap a): the visibility
 * policies must mutate the SAME query object the core controller later reads
 * through `ctx.query` → `ctx.request.query`. `createPolicyContext`'s
 * `Object.assign` copies `request` by reference (own property) but NOT the
 * `query` prototype getter, so the injected filter/status has to land on
 * `policyContext.request.query`; writing to a fresh `policyContext.query`
 * would be a silent no-op. `getMutableQuery` returns exactly that stable,
 * mutable reference.
 */
describe("getMutableQuery", () => {
  it("returns the SAME request.query reference so mutations reach the controller", () => {
    // Trap (a): identity matters. The controller reads ctx.request.query, so
    // the object we hand back must BE that object, not a copy.
    const existing: Record<string, any> = { filters: { requiresAck: { $eq: true } } };
    const policyContext: any = { request: { query: existing } };

    const query = getMutableQuery(policyContext);

    expect(query).toBe(existing);
    // A filter/status written through the returned handle is observed on the
    // real request query the controller later validates & sanitizes.
    query.filters = { id: { $in: [1, 2] } };
    query.status = "published";
    expect(policyContext.request.query.filters).toEqual({ id: { $in: [1, 2] } });
    expect(policyContext.request.query.status).toBe("published");
  });

  it("creates request.query when the request carries none and returns THAT object", () => {
    // Real Koa always exposes request.query, but a non-Koa stub may not; the
    // handle we return must still be the one that lives on request.query so
    // the write lands on the controller's read path.
    const policyContext: any = { request: {} };

    const query = getMutableQuery(policyContext);

    expect(policyContext.request.query).toBe(query);
    query.filters = { id: { $eq: -1 } };
    expect(policyContext.request.query.filters).toEqual({ id: { $eq: -1 } });
  });

  it("falls back to policyContext.query for a non-Koa context without request", () => {
    // No `request` object at all → last-resort fallback returns the bare
    // ctx.query as-is (===). This is the documented non-Koa escape hatch, not
    // the Koa path; it does NOT synthesise a `request`.
    const bare: Record<string, any> = { status: "draft" };
    const policyContext: any = { query: bare };

    const query = getMutableQuery(policyContext);

    expect(query).toBe(bare);
    expect("request" in policyContext).toBe(false);
  });

  it("creates policyContext.query when neither request nor query exist", () => {
    const policyContext: any = {};

    const query = getMutableQuery(policyContext);

    expect(policyContext.query).toBe(query);
    expect(query).toEqual({});
  });
});

/**
 * narrowFilters (PL01): the injected clause is $and-composed with the
 * client filter, never spread-merged, so a client key can neither replace
 * the policy's clause nor sit next to it as an alternative.
 */
describe("narrowFilters", () => {
  const clause = { user: { id: 7 } };

  it("stands alone without a client filter (never an empty $and)", () => {
    for (const filters of [undefined, null, ""]) {
      const query: Record<string, unknown> = filters === undefined ? {} : { filters };
      narrowFilters(query, clause);
      expect(query.filters, String(filters)).toBe(clause);
    }
  });

  it("wraps the client filter and the clause in one $and, client first", () => {
    const client = { title: { $eq: "x" } };
    const query: Record<string, unknown> = { filters: client };
    narrowFilters(query, clause);
    expect(query.filters).toEqual({ $and: [client, clause] });
    expect((query.filters as { $and: unknown[] }).$and[0]).toBe(client);
  });

  it("keeps a client key of the same name as a separate operand", () => {
    // A spread merge would let `user` of one side overwrite the other.
    const client = { user: { id: 99 }, $or: [{ id: 1 }, { id: 2 }] };
    const query: Record<string, unknown> = { filters: client };
    narrowFilters(query, clause);
    expect(query.filters).toEqual({ $and: [client, { user: { id: 7 } }] });
  });

  it("nests on repeated calls instead of flattening", () => {
    const query: Record<string, unknown> = { filters: { a: 1 } };
    narrowFilters(query, { b: 2 });
    narrowFilters(query, { c: 3 });
    expect(query.filters).toEqual({ $and: [{ $and: [{ a: 1 }, { b: 2 }] }, { c: 3 }] });
  });

  it("writes onto the query it is given (the real request query)", () => {
    const ctx = { request: { query: { filters: { a: 1 } } as Record<string, unknown> } };
    narrowFilters(getMutableQuery(ctx), clause);
    expect(ctx.request.query.filters).toEqual({ $and: [{ a: 1 }, clause] });
  });
});

/**
 * The bind-limit guard (PL04): an injected list beyond what one statement
 * may bind fails closed with an error log instead of an SQL error.
 */
describe("bind-limit guard", () => {
  const host = (client?: string) => ({
    db: client === undefined ? {} : { dialect: { client } },
    log: { error: vi.fn<(message: string) => void>() },
  });
  const ids = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

  it("uses the dialect's limit minus the headroom, SQLite's when unknown", () => {
    expect(BIND_LIMITS).toEqual({ postgres: 65535, sqlite: 32766 });
    expect(maxBoundValues(host("postgres"))).toBe(65535 - BIND_HEADROOM);
    expect(maxBoundValues(host("sqlite"))).toBe(32766 - BIND_HEADROOM);
    for (const client of [undefined, "mysql", "better-sqlite3"]) {
      expect(maxBoundValues(host(client)), String(client)).toBe(32766 - BIND_HEADROOM);
    }
    expect(maxBoundValues({})).toBe(32766 - BIND_HEADROOM);
  });

  it("passes a list up to the limit without a log", () => {
    const strapi = host("sqlite");
    const max = maxBoundValues(strapi);
    expect(fitsBindLimit(strapi, max, "test")).toBe(true);
    expect(boundedIdFilter(strapi, ids(3), "test")).toEqual({ id: { $in: [1, 2, 3] } });
    expect(boundedIdFilter(strapi, [], "test")).toEqual({ id: { $eq: -1 } });
    expect(strapi.log.error).not.toHaveBeenCalled();
  });

  it("fails closed beyond the limit, logging the count but no values", () => {
    const strapi = host("sqlite");
    const over = maxBoundValues(strapi) + 1;
    expect(fitsBindLimit(strapi, over, "document read policy")).toBe(false);
    expect(boundedIdFilter(strapi, ids(over), "document read policy")).toEqual({
      id: { $eq: -1 },
    });
    expect(strapi.log.error).toHaveBeenCalledTimes(2);
    const message = strapi.log.error.mock.calls[0][0];
    expect(message).toContain("[policy] document read policy");
    expect(message).toContain(String(over));
    expect(message).not.toContain("1, 2, 3");
  });

  it("allows Postgres more than SQLite", () => {
    const list = ids(40_000);
    const pg = host("postgres");
    expect(boundedIdFilter(pg, list, "t")).toEqual({ id: { $in: list } });
    const sqlite = host("sqlite");
    expect(boundedIdFilter(sqlite, list, "t")).toEqual({ id: { $eq: -1 } });
  });

  it("works without a log (fails closed all the same)", () => {
    expect(fitsBindLimit({ db: { dialect: { client: "sqlite" } } }, 1_000_000, "t")).toBe(false);
  });
});
