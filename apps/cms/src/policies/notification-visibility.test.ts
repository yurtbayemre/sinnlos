import { describe, expect, it } from "vitest";
import notificationVisibility from "./notification-visibility";

/**
 * Wiring test for the notification read guard (issue #24). Notifications are
 * personal: every non-admin role is narrowed to its OWN
 * (`recipient = caller`) by injecting a relational filter into the REAL
 * request query; `admin_role` bypasses the filter so /manage/analytics can
 * count unread notifications platform-wide.
 *
 * Pure query-injection policy — no `strapi.db` stub, no id-list traps. The
 * applicable trap is (a): the filter must land on
 * `policyContext.request.query`, not the throw-away `policyContext.query`
 * copy.
 */

const ADMIN_ROLE = 1;
const MEMBER_ROLE = 5;
const DEPARTMENT_HEAD_ROLE = 7;

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
  notificationVisibility(ctx, undefined, { strapi: {} } as any);

describe("notification-visibility policy", () => {
  it("rejects an anonymous caller without touching the query", async () => {
    const ctx = context(null);
    await expect(run(ctx)).resolves.toBe(false);
    expect(ctx.request.query.filters).toBeUndefined();
  });

  it("lets admin_role through without scoping the query", async () => {
    const admin = { id: 1, role: { id: ADMIN_ROLE, type: "admin_role" } };
    const ctx = context(admin, { filters: { read: { $eq: false } } });
    await expect(run(ctx)).resolves.toBe(true);
    // Bypass: the client filter survives verbatim, no `recipient` scoping added.
    expect(ctx.request.query.filters).toEqual({ read: { $eq: false } });
  });

  it("narrows a member to its OWN notifications", async () => {
    const member = { id: 42, role: { id: MEMBER_ROLE, type: "member" } };
    const ctx = context(member);
    await expect(run(ctx)).resolves.toBe(true);
    expect(ctx.request.query.filters).toEqual({ recipient: { id: 42 } });
  });

  it("narrows every non-admin role, not just members", async () => {
    const head = { id: 8, role: { id: DEPARTMENT_HEAD_ROLE, type: "department_head" } };
    const ctx = context(head);
    await run(ctx);
    expect(ctx.request.query.filters).toEqual({ recipient: { id: 8 } });
  });

  it("only NARROWS an existing client filter via $and (never replaces it)", async () => {
    const member = { id: 42, role: { id: MEMBER_ROLE, type: "member" } };
    const ctx = context(member, { filters: { read: { $eq: false } } });
    await run(ctx);
    // $and, so an incoming `recipient` filter can only shrink the set.
    expect(ctx.request.query.filters).toEqual({
      $and: [{ read: { $eq: false } }, { recipient: { id: 42 } }],
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
    expect(ctx.request.query.filters).toEqual({ recipient: { id: 42 } });
    expect(ctx.query).toBe(decoy);
    expect(ctx.query.filters).toBe("UNTOUCHED");
  });
});
