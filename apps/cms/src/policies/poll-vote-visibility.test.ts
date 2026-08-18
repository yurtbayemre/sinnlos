import { describe, expect, it } from "vitest";
import pollVoteVisibility from "./poll-vote-visibility";

/**
 * Wiring test for the poll-vote read guard (issue #24). Poll votes are never
 * listed directly by the app; leaving the core find route open would let a
 * caller populate `voter` and de-anonymize anonymous polls. So EVERY
 * authenticated caller — including admin_role — is narrowed to its own votes
 * (`voter = caller`). Crucially there is NO admin bypass here: an admin must
 * be scoped too, otherwise the de-anonymization hole reopens.
 *
 * Pure query-injection policy — no `strapi.db` stub, no id-list traps. The
 * applicable trap is (a): the filter must land on
 * `policyContext.request.query`, not the throw-away `policyContext.query`
 * copy.
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
  pollVoteVisibility(ctx, undefined, { strapi: {} } as any);

describe("poll-vote-visibility policy", () => {
  it("rejects an anonymous caller without touching the query", async () => {
    const ctx = context(null);
    await expect(run(ctx)).resolves.toBe(false);
    expect(ctx.request.query.filters).toBeUndefined();
  });

  it("narrows a member to its OWN votes", async () => {
    const member = { id: 42, role: { id: MEMBER_ROLE, type: "member" } };
    const ctx = context(member);
    await expect(run(ctx)).resolves.toBe(true);
    expect(ctx.request.query.filters).toEqual({ voter: { id: 42 } });
  });

  it("narrows admin_role too — NO bypass (de-anonymization guard)", async () => {
    const admin = { id: 1, role: { id: ADMIN_ROLE, type: "admin_role" } };
    const ctx = context(admin);
    await expect(run(ctx)).resolves.toBe(true);
    // Unlike the other visibility policies, admin is scoped to its own votes
    // so it can never unmask anonymous polls via the open find route.
    expect(ctx.request.query.filters).toEqual({ voter: { id: 1 } });
  });

  it("narrows a non-admin role that is not a plain member", async () => {
    const lead = { id: 7, role: { id: TEAM_LEAD_ROLE, type: "team_lead" } };
    const ctx = context(lead);
    await run(ctx);
    expect(ctx.request.query.filters).toEqual({ voter: { id: 7 } });
  });

  it("only NARROWS an existing client filter via $and (never replaces it)", async () => {
    const member = { id: 42, role: { id: MEMBER_ROLE, type: "member" } };
    const ctx = context(member, { filters: { poll: { id: { $eq: 3 } } } });
    await run(ctx);
    // $and, so a spoofed `voter` filter can only shrink the set, not widen it
    // to other voters' rows.
    expect(ctx.request.query.filters).toEqual({
      $and: [{ poll: { id: { $eq: 3 } } }, { voter: { id: 42 } }],
    });
  });

  it("writes the filter onto request.query, not a stray ctx.query (trap a)", async () => {
    const member = { id: 42, role: { id: MEMBER_ROLE, type: "member" } };
    const ctx = context(member);
    // Decoy OWN property `query`: the no-op trap would scope THIS object
    // (never read by the controller) and leave request.query fail-open.
    const decoy = { filters: "UNTOUCHED" };
    ctx.query = decoy;
    await run(ctx);
    expect(ctx.request.query.filters).toEqual({ voter: { id: 42 } });
    expect(ctx.query).toBe(decoy);
    expect(ctx.query.filters).toBe("UNTOUCHED");
  });
});
