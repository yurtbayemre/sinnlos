import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";
import {
  createStrapiStub,
  policyContext,
  type StubPolicyContext,
} from "../test/strapi-stub.test.helper";
import eventRsvpOwnRows from "./event-rsvp-own-rows";

/**
 * Read guard for the raw RSVP rows (FX21): every role reads only its OWN
 * rows (`user = caller`, injected into the REAL request query); admin_role
 * alone bypasses. An RSVP is a personal statement, so editor gets no
 * bypass. A client filter on the user relation is refused with 400 before
 * anything is injected. A pure query injection: no data is read.
 * policies.contract.test.ts pins the framework contract on top.
 */

function run(ctx: StubPolicyContext) {
  const strapi = createStrapiStub();
  const result = eventRsvpOwnRows(ctx, undefined, { strapi });
  return { result, strapi };
}

const member = { id: 42, role: { id: 5, type: "member" } };

describe("event-rsvp-own-rows policy", () => {
  it("refuses a request without a signed-in user and leaves the query alone", async () => {
    for (const user of [undefined, null]) {
      const ctx = policyContext(user, { query: { filters: { status: "no" } } });
      await expect(run(ctx).result).resolves.toBe(false);
      expect(ctx.request.query).toEqual({ filters: { status: "no" } });
    }
  });

  it("lets admin_role through untouched, user filters included (corrections)", async () => {
    const query = { filters: { user: { id: { $eq: 7 } }, status: "no" } };
    const ctx = policyContext({ id: 1, role: { id: 1, type: "admin_role" } }, { query });
    const { result, strapi } = run(ctx);
    await expect(result).resolves.toBe(true);
    expect(ctx.request.query).toEqual(query);
    expect(strapi.calls).toEqual([]);
  });

  it.each([
    "editor",
    "department_head",
    "team_lead",
    "member",
    "guest",
    "authenticated",
    "Admin_role",
    "admin",
  ])("narrows %s to its own rows", async (type) => {
    const ctx = policyContext({ id: 9, role: { id: 99, type } });
    await expect(run(ctx).result).resolves.toBe(true);
    expect(ctx.request.query.filters).toEqual({ user: { id: 9 } });
  });

  it("narrows a caller without a role like any other non-admin", async () => {
    for (const user of [{ id: 9 }, { id: 9, role: null }, { id: 9, role: { id: 5 } }]) {
      const ctx = policyContext(user);
      await expect(run(ctx).result).resolves.toBe(true);
      expect(ctx.request.query.filters).toEqual({ user: { id: 9 } });
    }
  });

  it("refuses a caller without a numeric id", async () => {
    for (const id of [undefined, "9", null] as unknown[]) {
      // A malformed state.user, as no users-permissions version produces it.
      const ctx = policyContext({ id: id as number | undefined, role: { type: "member" } });
      await expect(run(ctx).result).resolves.toBe(false);
      expect(ctx.request.query).toEqual({});
    }
  });

  it("only NARROWS a client filter via $and", async () => {
    const ctx = policyContext(member, {
      query: { filters: { targetDocumentId: { $in: ["a", "b"] }, status: "yes" } },
    });
    await expect(run(ctx).result).resolves.toBe(true);
    expect(ctx.request.query.filters).toEqual({
      $and: [{ targetDocumentId: { $in: ["a", "b"] }, status: "yes" }, { user: { id: 42 } }],
    });
  });

  it.each([
    ["the root", { user: { id: { $eq: 7 } } }],
    ["a bare id", { user: 7 }],
    ["a nested relation path", { user: { department: { name: "Ops" } } }],
    ["$or", { $or: [{ user: { id: 7 } }, { status: "no" }] }],
    ["$and inside $or", { $or: [{ $and: [{ status: "no" }, { user: { id: 7 } }] }] }],
    ["$not", { $not: { user: { id: 7 } } }],
    ["qs's object form of a long list", { $or: { 0: { status: "no" }, 25: { user: { id: 7 } } } }],
    ["a dotted key", { "user.id": 7 }],
  ])("refuses a user filter in %s with 400, before injecting anything", async (_label, filters) => {
    const ctx = policyContext(member, { query: { filters } });
    const outcome = run(ctx).result;
    await expect(outcome).rejects.toBeInstanceOf(errors.ValidationError);
    await expect(outcome).rejects.toThrow("Filtering RSVPs by user is not allowed");
    expect(ctx.request.query).toEqual({ filters });
  });

  it("does not mistake a value for a key", async () => {
    const ctx = policyContext(member, {
      query: { filters: { targetDocumentId: { $eq: "user" } } },
    });
    await expect(run(ctx).result).resolves.toBe(true);
  });

  it("writes onto the real request query, never the own `query` copy (§5.14)", async () => {
    const decoy = { filters: "DECOY" };
    const ctx = policyContext(member, { decoy });
    await expect(run(ctx).result).resolves.toBe(true);
    expect(ctx.query).toBe(decoy);
    expect(decoy).toEqual({ filters: "DECOY" });
    expect(ctx.request.query.filters).toEqual({ user: { id: 42 } });
  });
});
