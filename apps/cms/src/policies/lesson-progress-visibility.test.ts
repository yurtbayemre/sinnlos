import { describe, expect, it } from "vitest";
import { createStrapiStub, policyContext, type StubPolicyContext } from "../test/strapi-stub.test.helper";
import lessonProgressVisibility from "./lesson-progress-visibility";

/**
 * Read guard for lesson-progress rows (issue #29), the documented clone of
 * acknowledgement-visibility: every role reads only its OWN completion
 * receipts (`user = caller`), injected into the REAL request query;
 * admin_role alone bypasses (the /manage/training report). Progress is
 * personnel data, so editor gets no bypass (same posture as notifications
 * and acknowledgements). lesson-progress has no draft & publish, so the
 * status is not touched. A pure query injection: no data is read.
 */

const LESSON_PROGRESS_UID = "api::lesson-progress.lesson-progress";

function run(ctx: StubPolicyContext) {
  const strapi = createStrapiStub({ tables: { [LESSON_PROGRESS_UID]: [{ id: 1, user: { id: 42 } }] } });
  // The policy's own parameter type is the loose Strapi context.
  const result = lessonProgressVisibility(ctx, undefined, { strapi });
  return { result, strapi };
}

const member = { id: 42, role: { id: 5, type: "member" } };

describe("lesson-progress-visibility policy", () => {
  it("refuses a request without a signed-in user and leaves the query alone", async () => {
    for (const user of [undefined, null]) {
      const ctx = policyContext(user, { query: { filters: { a: 1 } } });
      await expect(run(ctx).result).resolves.toBe(false);
      expect(ctx.request.query).toEqual({ filters: { a: 1 } });
    }
  });

  it("lets admin_role through without scoping the query (the training report)", async () => {
    const ctx = policyContext(
      { id: 1, role: { id: 1, type: "admin_role" } },
      { query: { filters: { lesson: { $eq: "x" } } } },
    );
    await expect(run(ctx).result).resolves.toBe(true);
    expect(ctx.request.query).toEqual({ filters: { lesson: { $eq: "x" } } });
  });

  it("gives editor NO bypass: progress is personnel data", async () => {
    const ctx = policyContext({ id: 7, role: { id: 2, type: "editor" } });
    await expect(run(ctx).result).resolves.toBe(true);
    expect(ctx.request.query.filters).toEqual({ user: { id: 7 } });
  });

  it.each(["department_head", "team_lead", "member", "guest", "authenticated", "Admin_role", "admin"])(
    "narrows %s to its own receipts",
    async (type) => {
      const ctx = policyContext({ id: 9, role: { id: 99, type } });
      await expect(run(ctx).result).resolves.toBe(true);
      expect(ctx.request.query.filters).toEqual({ user: { id: 9 } });
    },
  );

  it("narrows a caller without a role like any other non-admin", async () => {
    for (const user of [{ id: 9 }, { id: 9, role: null }, { id: 9, role: { id: 5 } }]) {
      const ctx = policyContext(user);
      await expect(run(ctx).result).resolves.toBe(true);
      expect(ctx.request.query.filters).toEqual({ user: { id: 9 } });
    }
  });

  it("only NARROWS a client filter via $and, so a client `user` filter cannot widen it", async () => {
    const ctx = policyContext(member, { query: { filters: { user: { id: { $in: [1, 2, 42] } } } } });
    await run(ctx).result;
    expect(ctx.request.query.filters).toEqual({
      $and: [{ user: { id: { $in: [1, 2, 42] } } }, { user: { id: 42 } }],
    });
  });

  it("writes onto request.query, never the own `query` copy (§5.14)", async () => {
    const decoy = { filters: "UNTOUCHED" };
    const ctx = policyContext(member, { decoy });
    await run(ctx).result;
    expect(ctx.request.query.filters).toEqual({ user: { id: 42 } });
    expect(ctx.query).toBe(decoy);
    expect(decoy).toEqual({ filters: "UNTOUCHED" });
  });

  it("creates request.query for a bare request stub (getMutableQuery fallback)", async () => {
    const ctx: StubPolicyContext = { state: { user: member }, request: { query: undefined as unknown as Record<string, unknown> } };
    await expect(run(ctx).result).resolves.toBe(true);
    expect(ctx.request.query).toEqual({ filters: { user: { id: 42 } } });
  });

  it("does not pin a status (no draft & publish) and reads no data", async () => {
    const ctx = policyContext(member, { query: { status: "draft", publicationFilter: "never-published" } });
    const { result, strapi } = run(ctx);
    await expect(result).resolves.toBe(true);
    expect(ctx.request.query).toEqual({
      status: "draft",
      publicationFilter: "never-published",
      filters: { user: { id: 42 } },
    });
    expect(strapi.calls).toEqual([]);
  });

  it("the injected filter selects exactly the caller's rows", async () => {
    const strapi = createStrapiStub({
      tables: {
        [LESSON_PROGRESS_UID]: [
          { id: 1, user: { id: 42 } },
          { id: 2, user: { id: 43 } },
          { id: 3, user: null },
        ],
      },
    });
    const ctx = policyContext(member);
    await lessonProgressVisibility(ctx, undefined, { strapi });
    const rows = await strapi.db
      .query(LESSON_PROGRESS_UID)
      .findMany({ where: ctx.request.query.filters as Record<string, unknown>, select: ["id"] });
    expect(rows).toEqual([{ id: 1 }]);
  });
});
