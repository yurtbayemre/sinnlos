import { describe, expect, it } from "vitest";
import documentVisibility from "./document-visibility";

/**
 * Wiring test for the document read policy: it resolves the caller's
 * department in JS and injects a NON-relational id filter into the REAL
 * request query. `document` scopes via a `departments` manyToMany relation:
 * a document with NO departments is company-wide; a document WITH
 * departments is visible only to members of one of them.
 *
 * The regression traps this pins down (see utils/policy-query.ts, issue #24):
 *   (a) the filter must land on `policyContext.request.query`, not on the
 *       throw-away `policyContext.query` copy,
 *   (b) an empty visible-id list must stay restrictive (`$eq: -1`, never the
 *       fail-open `$in: []`),
 *   (d) the id list spans drafts AND published rows, so the publication state
 *       must be pinned server-side ("published"); admin/editor bypass first.
 *   (c) documentId-vs-id is N/A here — this is a read policy that never looks
 *       a single row up by primary key.
 *
 * The policy only touches `strapi.db.query`, so a small stub is enough — no
 * Strapi runtime, no database.
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
const DOCS = [
  { id: 1 },
  { id: 2, departments: [{ id: ENGINEERING }] },
  { id: 3, departments: [{ id: DESIGN }] },
  { id: 4, departments: [{ id: ENGINEERING }, { id: DESIGN }] },
];

function stubStrapi(users: StubUser[], docs: unknown[] = DOCS) {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async ({ where }: any) => users.find((u) => u.id === where.id) ?? null,
        findMany: async () => (uid === "api::document.document" ? docs : []),
      }),
    },
  };
}

/**
 * Minimal Koa-ish policy context: `query` lives on `request`, which is the
 * only object the controller later reads through (`ctx.query` delegates to
 * `ctx.request.query`). `query` carries whatever the CLIENT sent.
 */
function context(user: StubUser | null, query: Record<string, unknown> = {}) {
  return {
    state: user ? { user } : {},
    request: { query: { ...query } },
  } as any;
}

const run = (ctx: any, users: StubUser[], docs?: unknown[]) =>
  documentVisibility(ctx, undefined, { strapi: stubStrapi(users, docs) } as any);

const engineer: StubUser = {
  id: 2,
  role: { id: MEMBER_ROLE, type: "member" },
  department: { id: ENGINEERING },
};

describe("document-visibility policy", () => {
  it("lets admin_role through without touching the query (trap d bypass)", async () => {
    const admin = { id: 1, role: { id: 1, type: "admin_role" } };
    const ctx = context(admin, { status: "draft" });
    await expect(run(ctx, [admin])).resolves.toBe(true);
    expect(ctx.request.query.filters).toBeUndefined();
    // Bypass happens BEFORE the status is pinned — admins author the drafts
    // and must keep reading them.
    expect(ctx.request.query.status).toBe("draft");
  });

  it("lets editor through without touching the query", async () => {
    const ed = { id: 1, role: { id: 3, type: "editor" } };
    const ctx = context(ed, { status: "draft" });
    await expect(run(ctx, [ed])).resolves.toBe(true);
    expect(ctx.request.query.filters).toBeUndefined();
    expect(ctx.request.query.status).toBe("draft");
  });

  it("shows a member the company-wide docs plus their own department's", async () => {
    const ctx = context(engineer);
    await run(ctx, [engineer]);
    // #1 company-wide, #2 + #4 tagged Engineering; #3 is Design-only.
    expect(ctx.request.query.filters).toEqual({ id: { $in: [1, 2, 4] } });
  });

  it("scopes a different department to its own docs", async () => {
    const designer: StubUser = {
      id: 3,
      role: { id: MEMBER_ROLE, type: "member" },
      department: { id: DESIGN },
    };
    const ctx = context(designer);
    await run(ctx, [designer]);
    expect(ctx.request.query.filters).toEqual({ id: { $in: [1, 3, 4] } });
  });

  it("gives an anonymous caller only the company-wide docs", async () => {
    const ctx = context(null);
    await run(ctx, []);
    expect(ctx.request.query.filters).toEqual({ id: { $in: [1] } });
  });

  it("gives a member without a department only the company-wide docs", async () => {
    const orphan: StubUser = { id: 9, role: { id: MEMBER_ROLE, type: "member" } };
    const ctx = context(orphan);
    await run(ctx, [orphan]);
    expect(ctx.request.query.filters).toEqual({ id: { $in: [1] } });
  });

  it("stays restrictive when nothing is visible (no fail-open empty $in — trap b)", async () => {
    // Strip the company-wide row so every remaining doc is department-scoped,
    // then query as anonymous (no department) → nothing is visible.
    const onlyScoped = DOCS.filter((d) => d.id !== 1);
    const ctx = context(null);
    await run(ctx, [], onlyScoped);
    expect(ctx.request.query.filters).toEqual({ id: { $eq: -1 } });
  });

  it("keeps a caller-supplied filter and only narrows it", async () => {
    const ctx = context(engineer, { filters: { archived: { $eq: false } } });
    await run(ctx, [engineer]);
    expect(ctx.request.query.filters).toEqual({
      $and: [{ archived: { $eq: false } }, { id: { $in: [1, 2, 4] } }],
    });
  });

  it("writes onto request.query, never the throw-away ctx.query copy (trap a)", async () => {
    const ctx = context(engineer);
    // Mimic the createPolicyContext no-op: a bare own-property `query` that
    // the controller never reads. The policy must ignore it.
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
