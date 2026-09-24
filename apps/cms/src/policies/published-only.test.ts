import { describe, expect, it } from "vitest";
import publishedOnly from "./published-only";

/**
 * Wiring test for the publication pin on event/poll/department/team reads
 * (FX06, modelled on announcement-visibility.test.ts). Pinned traps:
 *   1. the status lands on `policyContext.request.query` — the controller
 *      never reads the throw-away `policyContext.query` copy (§5.14),
 *   2. a client `?status=draft` is overwritten, and the legacy v4
 *      `publicationState` is removed (§5.24),
 *   3. admin_role/editor bypass BEFORE the pin and keep their drafts,
 *   4. strict `true` (undefined would also pass, but must never be relied on).
 */

function context(user: unknown, query: Record<string, unknown> = {}) {
  return { state: user ? { user } : {}, request: { query: { ...query } } };
}

const as = (type: string) => ({ id: 1, role: { type } });

describe("published-only policy", () => {
  it.each(["admin_role", "editor"])("lets %s keep ?status=draft (authoring)", (type) => {
    const ctx = context(as(type), { status: "draft", publicationState: "preview" });
    expect(publishedOnly(ctx)).toBe(true);
    expect(ctx.request.query).toEqual({ status: "draft", publicationState: "preview" });
  });

  it.each(["member", "guest", "department_head", "team_lead", "authenticated"])(
    "overwrites ?status=draft with 'published' for %s",
    (type) => {
      const ctx = context(as(type), { status: "draft" });
      expect(publishedOnly(ctx)).toBe(true);
      expect(ctx.request.query.status).toBe("published");
    },
  );

  it("pins an anonymous caller too (no bypass without a role)", () => {
    const ctx = context(null, { status: "draft" });
    expect(publishedOnly(ctx)).toBe(true);
    expect(ctx.request.query.status).toBe("published");
  });

  it("pins the status even when the client sent none", () => {
    const ctx = context(as("member"));
    publishedOnly(ctx);
    expect(ctx.request.query.status).toBe("published");
  });

  it("removes the legacy v4 publicationState param", () => {
    const ctx = context(as("member"), { publicationState: "preview" });
    publishedOnly(ctx);
    expect("publicationState" in ctx.request.query).toBe(false);
  });

  it("leaves filters/populate alone and writes to request.query, not policyContext.query", () => {
    const ctx = {
      ...context(as("member"), { status: "draft", filters: { slug: { $eq: "x" } }, populate: "*" }),
      query: { status: "draft" },
    };
    publishedOnly(ctx);
    expect(ctx.request.query).toEqual({
      status: "published",
      filters: { slug: { $eq: "x" } },
      populate: "*",
    });
    expect(ctx.query.status).toBe("draft");
  });
});
