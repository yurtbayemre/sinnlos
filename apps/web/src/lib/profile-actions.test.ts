import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "./strapi-error";

/**
 * FX11 for the change-password action: the client IP is forwarded as
 * X-Forwarded-For (the CMS trusts it via server.proxy.koa, like sign-in and
 * register), and Strapi's throttle 429 becomes the distinct
 * profile.passwordRateLimited message instead of "check your current
 * password". `@/lib/strapi` is mocked; its StrapiError is the real class.
 */
const strapiMock = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>();
const state = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("@/lib/strapi", () => ({
  strapi: (path: string, init?: RequestInit) => strapiMock(path, init),
}));
vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  unstable_rethrow: (e: unknown) => {
    if (e instanceof Error && e.message.startsWith("NEXT_REDIRECT")) throw e;
  },
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

const { changePassword } = await import("./profile-actions");

const form = (fields: Record<string, string> = {}) => {
  const data = new FormData();
  const values = {
    currentPassword: "old-password",
    password: "new-password",
    passwordConfirmation: "new-password",
    ...fields,
  };
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

beforeEach(() => {
  strapiMock.mockReset();
  strapiMock.mockResolvedValue({ jwt: "x" });
  state.headers = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.2" });
});

describe("changePassword", () => {
  it("forwards the client IP to Strapi's change-password route", async () => {
    await expect(changePassword({}, form())).resolves.toEqual({ success: "Password changed." });
    const [path, init] = strapiMock.mock.calls[0]!;
    expect(path).toBe("/api/auth/change-password");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-forwarded-for")).toBe("203.0.113.7");
  });

  it("maps Strapi's throttle (429) to the passwordRateLimited message", async () => {
    strapiMock.mockRejectedValue(new StrapiError(429, "Too Many Requests", "{}"));
    await expect(changePassword({}, form())).resolves.toEqual({
      error: "profile.passwordRateLimited",
    });
  });

  it("keeps the current-password hint for a rejected current password (400)", async () => {
    strapiMock.mockRejectedValue(new StrapiError(400, "Bad Request", "{}"));
    await expect(changePassword({}, form())).resolves.toEqual({
      error: "Could not change password — check your current password.",
    });
  });

  it("lets strapi()'s expired-session redirect escape", async () => {
    strapiMock.mockRejectedValue(new Error("NEXT_REDIRECT /sign-in?expired=1"));
    await expect(changePassword({}, form())).rejects.toThrow("NEXT_REDIRECT");
  });

  it("validates locally before calling Strapi", async () => {
    await expect(changePassword({}, form({ password: "short" }))).resolves.toEqual({
      error: "New password needs at least 6 characters.",
    });
    await expect(changePassword({}, form({ passwordConfirmation: "different" }))).resolves.toEqual({
      error: "Passwords do not match.",
    });
    expect(strapiMock).not.toHaveBeenCalled();
  });
});
