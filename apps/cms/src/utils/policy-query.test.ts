import { describe, expect, it } from "vitest";
import { restrictiveIdFilter } from "./policy-query";

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
