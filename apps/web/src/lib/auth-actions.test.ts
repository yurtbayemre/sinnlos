import { beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialsSignin } from "next-auth";
import { StrapiRateLimitedSignIn } from "./auth-errors";

/**
 * FX11: when Strapi's own auth throttle answers 429, authorize() throws
 * StrapiRateLimitedSignIn and the sign-in form must say "too many attempts"
 * (auth.rateLimited, EN+DE) — not "Invalid email or password". The real
 * authorize() → 429 path is pinned in auth.test.ts; here `@/auth` signIn is
 * mocked to reject the way Auth.js' raw signIn() does (it rethrows
 * CredentialsSignin subclasses, @auth/core index.js).
 */
const signInMock = vi.fn<(provider: string, options: unknown) => Promise<never>>();
vi.mock("@/auth", () => ({
  signIn: (provider: string, options: unknown) => signInMock(provider, options),
  signOut: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSession: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

const { signInWithCredentials } = await import("./auth-actions");

const form = () => {
  const data = new FormData();
  data.set("identifier", "ada@example.test");
  data.set("password", "pw");
  data.set("from", "/");
  return data;
};

beforeEach(() => {
  signInMock.mockReset();
});

describe("signInWithCredentials", () => {
  it("maps Strapi's throttle (429) to the rateLimited message", async () => {
    signInMock.mockRejectedValue(new StrapiRateLimitedSignIn());
    await expect(signInWithCredentials(undefined, form())).resolves.toEqual({
      error: "auth.rateLimited",
    });
  });

  it("keeps the generic message for wrong credentials", async () => {
    signInMock.mockRejectedValue(new CredentialsSignin());
    await expect(signInWithCredentials(undefined, form())).resolves.toEqual({
      error: "Invalid email or password.",
    });
  });

  it("rethrows the NEXT_REDIRECT that signals a successful sign-in", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/" });
    signInMock.mockRejectedValue(redirect);
    await expect(signInWithCredentials(undefined, form())).rejects.toBe(redirect);
  });
});
