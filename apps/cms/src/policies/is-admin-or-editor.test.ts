import { describe, expect, it } from "vitest";
import isAdminOrEditor from "./is-admin-or-editor";

/**
 * Wiring test for the `is-admin-or-editor` gate (issue #24). It is a PURE
 * predicate: it reads only `policyContext.state.user.role.type` and returns
 * a boolean, so no Strapi runtime, no request query and no database are
 * involved. The privileged set is exactly {admin_role, editor}; everything
 * else — including a caller with no user or no role type — must be denied.
 *
 * Note: this policy is SYNCHRONOUS (returns a plain boolean, not a Promise),
 * so we assert on the return value directly rather than via `.resolves`.
 */

interface StubUser {
  id: number;
  role?: { id: number; type: string };
}

function context(user: StubUser | null) {
  return { state: user ? { user } : {} } as any;
}

const run = (user: StubUser | null) =>
  isAdminOrEditor(context(user), undefined, { strapi: {} } as any);

describe("is-admin-or-editor policy", () => {
  it("admits an admin_role user", () => {
    expect(run({ id: 1, role: { id: 1, type: "admin_role" } })).toBe(true);
  });

  it("admits an editor", () => {
    expect(run({ id: 2, role: { id: 2, type: "editor" } })).toBe(true);
  });

  it.each([
    ["member", "member"],
    ["team_lead", "team_lead"],
    ["department_head", "department_head"],
    ["guest", "guest"],
  ])("denies an unprivileged %s", (_label, type) => {
    expect(run({ id: 3, role: { id: 3, type } })).toBe(false);
  });

  it("denies an anonymous caller (no user on state)", () => {
    expect(run(null)).toBe(false);
  });

  it("denies a user whose role carries no type", () => {
    // The `!user?.role?.type` guard must fire before the includes() check.
    expect(run({ id: 9, role: { id: 4 } } as any)).toBe(false);
  });

  it("denies a user with no role relation at all", () => {
    expect(run({ id: 9 } as any)).toBe(false);
  });
});
