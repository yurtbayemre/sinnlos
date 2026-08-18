import { describe, expect, it } from "vitest";
import quickLinkVisibility from "./quick-link-visibility";

/**
 * Wiring test for the quick-link read policy. Same department-scoped
 * id-injection pattern as document-visibility (see there for the full
 * rationale): a link with NO departments is company-wide; a link WITH
 * departments is visible only to members of one of them; admin/editor bypass.
 *
 * The regression traps this pins down (utils/policy-query.ts, issue #24):
 *   (a) the filter must land on `policyContext.request.query`, not the
 *       throw-away `policyContext.query` copy,
 *   (b) an empty visible-id list stays restrictive (`$eq: -1`, never `$in: []`),
 *   (d) the id list spans drafts AND published, so status is pinned
 *       "published" server-side; admin/editor bypass first.
 *   (c) documentId-vs-id is N/A — read policy, no single-row primary-key lookup.
 */

const ENGINEERING = 1;
const DESIGN = 2;
const MEMBER_ROLE = 5;

interface StubUser {
  id: number;
  role?: { id: number; type: string };
  department?: { id: number };
}

/** #1 company-wide, #2 Engineering, #3 Design, #4 Engineering+Design. */
const LINKS = [
  { id: 1 },
  { id: 2, departments: [{ id: ENGINEERING }] },
  { id: 3, departments: [{ id: DESIGN }] },
  { id: 4, departments: [{ id: ENGINEERING }, { id: DESIGN }] },
];

function stubStrapi(users: StubUser[], links: unknown[] = LINKS) {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async ({ where }: any) => users.find((u) => u.id === where.id) ?? null,
        findMany: async () => (uid === "api::quick-link.quick-link" ? links : []),
      }),
    },
  };
}

function context(user: StubUser | null, query: Record<string, unknown> = {}) {
  return {
    state: user ? { user } : {},
    request: { query: { ...query } },
  } as any;
}

const run = (ctx: any, users: StubUser[], links?: unknown[]) =>
  quickLinkVisibility(ctx, undefined, { strapi: stubStrapi(users, links) } as any);

const engineer: StubUser = {
  id: 2,
  role: { id: MEMBER_ROLE, type: "member" },
  department: { id: ENGINEERING },
};

describe("quick-link-visibility policy", () => {
  it("lets admin_role through without touching the query (trap d bypass)", async () => {
    const admin = { id: 1, role: { id: 1, type: "admin_role" } };
    const ctx = context(admin, { status: "draft" });
    await expect(run(ctx, [admin])).resolves.toBe(true);
    expect(ctx.request.query.filters).toBeUndefined();
    expect(ctx.request.query.status).toBe("draft");
  });

  it("lets editor through without touching the query", async () => {
    const ed = { id: 1, role: { id: 3, type: "editor" } };
    const ctx = context(ed, { status: "draft" });
    await expect(run(ctx, [ed])).resolves.toBe(true);
    expect(ctx.request.query.filters).toBeUndefined();
    expect(ctx.request.query.status).toBe("draft");
  });

  it("shows a member the company-wide links plus their own department's", async () => {
    const ctx = context(engineer);
    await run(ctx, [engineer]);
    expect(ctx.request.query.filters).toEqual({ id: { $in: [1, 2, 4] } });
  });

  it("scopes a different department to its own links", async () => {
    const designer: StubUser = {
      id: 3,
      role: { id: MEMBER_ROLE, type: "member" },
      department: { id: DESIGN },
    };
    const ctx = context(designer);
    await run(ctx, [designer]);
    expect(ctx.request.query.filters).toEqual({ id: { $in: [1, 3, 4] } });
  });

  it("gives an anonymous caller only the company-wide links", async () => {
    const ctx = context(null);
    await run(ctx, []);
    expect(ctx.request.query.filters).toEqual({ id: { $in: [1] } });
  });

  it("gives a member without a department only the company-wide links", async () => {
    const orphan: StubUser = { id: 9, role: { id: MEMBER_ROLE, type: "member" } };
    const ctx = context(orphan);
    await run(ctx, [orphan]);
    expect(ctx.request.query.filters).toEqual({ id: { $in: [1] } });
  });

  it("stays restrictive when nothing is visible (no fail-open empty $in — trap b)", async () => {
    const onlyScoped = LINKS.filter((l) => l.id !== 1);
    const ctx = context(null);
    await run(ctx, [], onlyScoped);
    expect(ctx.request.query.filters).toEqual({ id: { $eq: -1 } });
  });

  it("keeps a caller-supplied filter and only narrows it", async () => {
    const ctx = context(engineer, { filters: { pinned: { $eq: true } } });
    await run(ctx, [engineer]);
    expect(ctx.request.query.filters).toEqual({
      $and: [{ pinned: { $eq: true } }, { id: { $in: [1, 2, 4] } }],
    });
  });

  it("writes onto request.query, never the throw-away ctx.query copy (trap a)", async () => {
    const ctx = context(engineer);
    ctx.query = {};
    await run(ctx, [engineer]);
    expect(ctx.request.query.filters).toEqual({ id: { $in: [1, 2, 4] } });
    expect(ctx.query.filters).toBeUndefined();
  });

  describe("publication state (trap d)", () => {
    it("overrides a client-supplied ?status=draft with 'published'", async () => {
      const ctx = context(engineer, { status: "draft" });
      await run(ctx, [engineer]);
      expect(ctx.request.query.status).toBe("published");
    });

    it("pins the status even when the client sent none", async () => {
      const ctx = context(engineer);
      await run(ctx, [engineer]);
      expect(ctx.request.query.status).toBe("published");
    });

    it("removes the legacy v4 publicationState param", async () => {
      const ctx = context(engineer, { status: "draft", publicationState: "preview" });
      await run(ctx, [engineer]);
      expect(ctx.request.query.status).toBe("published");
      expect("publicationState" in ctx.request.query).toBe(false);
    });

    it("pins the status without disturbing the injected id filter", async () => {
      const ctx = context(engineer, { status: "draft" });
      await run(ctx, [engineer]);
      expect(ctx.request.query.filters).toEqual({ id: { $in: [1, 2, 4] } });
    });
  });
});
