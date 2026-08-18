import { describe, expect, it } from "vitest";
import { forcePublishedStatus, getMutableQuery, restrictiveIdFilter } from "./policy-query";

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
