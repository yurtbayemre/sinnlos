import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * signOutAction (D-ENTRA-01 spec C, "Pages and sign-out"): a Microsoft
 * session is sent to the configured tenant's end-session endpoint, built
 * from the tenant GUID (AUTH_MICROSOFT_ENTRA_ID_ISSUER is gone); a local
 * session, or any session while Entra is off, goes to /sign-in. Fake GUIDs.
 */
const TENANT = "11111111-2222-4333-8444-555555555555";

const state = vi.hoisted(() => ({
  provider: undefined as string | undefined,
  redirects: [] as string[],
  signOuts: 0,
}));

vi.mock("@/auth", () => ({
  signIn: vi.fn(),
  signOut: async () => {
    state.signOuts += 1;
  },
}));
vi.mock("@/lib/session", () => ({
  getSession: async () => (state.provider ? { provider: state.provider, user: { id: 1 } } : null),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "intranet.example.test" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    state.redirects.push(url);
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${url}` });
  },
}));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));

const ENTRA_ENV = {
  ENTRA_ENABLED: "1",
  AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: TENANT,
  AUTH_MICROSOFT_ENTRA_ID_ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  AUTH_MICROSOFT_ENTRA_ID_SECRET: "client-secret-value",
  ENTRA_EXCHANGE_SECRET: "0123456789abcdef0123456789abcdef",
  AUTH_URL: "https://intranet.example.test",
  AUTH_MICROSOFT_ENTRA_ID_ISSUER: undefined,
};

async function signOutWith(env: Record<string, string | undefined>, provider: string | undefined) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  state.provider = provider;
  const { signOutAction } = await import("./auth-actions");
  await expect(signOutAction()).rejects.toThrow("NEXT_REDIRECT");
  return state.redirects.at(-1);
}

// The cold transform of auth-actions and its imports can take seconds under
// a full parallel run; pay it once here, under the hook timeout.
beforeAll(async () => {
  await import("./auth-actions");
}, 30_000);

beforeEach(() => {
  state.redirects = [];
  state.signOuts = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("signOutAction", () => {
  it("sends a Microsoft session to the tenant's end-session endpoint", async () => {
    const target = new URL((await signOutWith(ENTRA_ENV, "microsoft-entra-id")) ?? "about:blank");
    expect(`${target.origin}${target.pathname}`).toBe(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`,
    );
    expect(target.searchParams.get("post_logout_redirect_uri")).toBe("https://intranet.example.test/sign-in");
    expect(state.signOuts).toBe(1);
  });

  it("sends a local session to /sign-in", async () => {
    expect(await signOutWith(ENTRA_ENV, "local")).toBe("/sign-in");
  });

  it("sends every session to /sign-in while Entra is off, even with a legacy issuer set", async () => {
    const off = {
      ...ENTRA_ENV,
      ENTRA_ENABLED: undefined,
      AUTH_MICROSOFT_ENTRA_ID_ISSUER: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    };
    expect(await signOutWith(off, "microsoft-entra-id")).toBe("/sign-in");
  });
});
