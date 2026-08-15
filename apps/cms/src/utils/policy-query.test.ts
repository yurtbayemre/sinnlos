import { describe, expect, it } from "vitest";
import { forcePublishedStatus, restrictiveIdFilter } from "./policy-query";

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
