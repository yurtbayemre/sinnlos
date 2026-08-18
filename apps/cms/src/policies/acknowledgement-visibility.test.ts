import { describe, expect, it } from "vitest";
import acknowledgementVisibility from "./acknowledgement-visibility";

/**
 * Wiring test for the acknowledgement read guard (issue #24). Every
 * non-admin role is narrowed to its OWN acknowledgements (`user = caller`)
 * by injecting a relational filter into the REAL request query;
 * `admin_role` bypasses the filter so the /manage report can aggregate
 * across users.
 *
 * This is a pure query-injection policy: it touches no database and no id
 * list, so it needs no `strapi.db` stub and none of the id-filter traps
 * (empty-$in, documentId-vs-id, forcePublishedStatus) apply. The one trap
 * that DOES apply is (a): the filter must land on
 * `policyContext.request.query`, never the throw-away `policyContext.query`
 * copy that `createPolicyContext`'s Object.assign leaves behind.
 */

const ADMIN_ROLE = 1;
const MEMBER_ROLE = 5;
const TEAM_LEAD_ROLE = 6;

interface StubUser {
  id: number;
  role?: { id: number; type: string };
}

function context(user: StubUser | null, query: Record<string, unknown> = {}) {
  return {
    state: user ? { user } : {},
    request: { query: { ...query } },
  } as any;
}

const run = (ctx: any) =>
  acknowledgementVisibility(ctx, undefined, { strapi: {} } as any);

describe("acknowledgement-visibility policy", () => {
  it("rejects an anonymous caller without touching the query", async () => {
    const ctx = context(null);
    await expect(run(ctx)).resolves.toBe(false);
    expect(ctx.request.query.filters).toBeUndefined();
  });

  it("lets admin_role through without scoping the query", async () => {
    const admin = { id: 1, role: { id: ADMIN_ROLE, type: "admin_role" } };
    const ctx = context(admin, { filters: { note: { $contains: "x" } } });
    await expect(run(ctx)).resolves.toBe(true);
    // Bypass: the client filter survives verbatim, no `user` scoping added.
    expect(ctx.request.query.filters).toEqual({ note: { $contains: "x" } });
  });

  it("narrows a member to its OWN acknowledgements", async () => {
    const member = { id: 42, role: { id: MEMBER_ROLE, type: "member" } };
    const ctx = context(member);
    await expect(run(ctx)).resolves.toBe(true);
    expect(ctx.request.query.filters).toEqual({ user: { id: 42 } });
  });

  it("narrows every non-admin role, not just members", async () => {
    const lead = { id: 7, role: { id: TEAM_LEAD_ROLE, type: "team_lead" } };
    const ctx = context(lead);
    await run(ctx);
    expect(ctx.request.query.filters).toEqual({ user: { id: 7 } });
  });

  it("only NARROWS an existing client filter via $and (never replaces it)", async () => {
    const member = { id: 42, role: { id: MEMBER_ROLE, type: "member" } };
    const ctx = context(member, { filters: { acknowledgedAt: { $notNull: true } } });
    await run(ctx);
    // $and, so an incoming `user` filter can only shrink the set, not widen it.
    expect(ctx.request.query.filters).toEqual({
      $and: [{ acknowledgedAt: { $notNull: true } }, { user: { id: 42 } }],
    });
  });

  it("writes the filter onto request.query, not a stray ctx.query (trap a)", async () => {
    const member = { id: 42, role: { id: MEMBER_ROLE, type: "member" } };
    const ctx = context(member);
    // Decoy OWN property `query`, distinct from request.query. The Koa no-op
    // trap would mutate THIS object (which the controller never reads) and
    // leave request.query — the object sanitizeQuery/validateQuery see —
    // unscoped, i.e. fail-open.
    const decoy = { filters: "UNTOUCHED" };
    ctx.query = decoy;
    await run(ctx);
    expect(ctx.request.query.filters).toEqual({ user: { id: 42 } });
    expect(ctx.query).toBe(decoy);
    expect(ctx.query.filters).toBe("UNTOUCHED");
  });
});
