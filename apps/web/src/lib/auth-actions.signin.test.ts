import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * signInWithCredentials (v0.30): input longer than a sign-in accepts is
 * answered before the limiter peek and Auth.js, and the identifier is not
 * echoed back. Normal input still reaches signIn("local").
 */
const state = vi.hoisted(() => ({ signIns: 0 }));

vi.mock("@/auth", () => ({
  signIn: async () => {
    state.signIns += 1;
  },
  signOut: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSession: async () => null }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), unstable_rethrow: vi.fn() }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));

const form = (identifier: string, password: string) => {
  const data = new FormData();
  data.set("identifier", identifier);
  data.set("password", password);
  return data;
};

// The cold transform of auth-actions and its imports can take seconds under
// a full parallel run; pay it once here, under the hook timeout.
beforeAll(async () => {
  await import("./auth-actions");
}, 30_000);

beforeEach(() => {
  state.signIns = 0;
});

describe("signInWithCredentials: input bounds", () => {
  it("answers over-long input without the limiter, Auth.js or an echo", async () => {
    const { signInWithCredentials } = await import("./auth-actions");
    const { loginRateLimiter } = await import("@/lib/login-rate-limit");
    const before = loginRateLimiter.size();
    for (const [identifier, password] of [
      ["a".repeat(20_000), "pw"],
      ["ada@example.test", "p".repeat(5_000)],
    ]) {
      await expect(signInWithCredentials({}, form(identifier, password))).resolves.toEqual({
        error: "invalidCredentials",
      });
    }
    expect(state.signIns).toBe(0);
    expect(loginRateLimiter.size()).toBe(before);
  });

  it("hands normal input to signIn('local')", async () => {
    const { signInWithCredentials } = await import("./auth-actions");
    await signInWithCredentials({}, form("ada@example.test", "pw"));
    expect(state.signIns).toBe(1);
  });
});
