import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * signOutAction (D-ENTRA-01 spec C, "Pages and sign-out"): a Microsoft
 * session is sent to the configured tenant's end-session endpoint, built
 * from the tenant GUID (AUTH_MICROSOFT_ENTRA_ID_ISSUER is gone); a local
 * session, or any session while Entra is off, goes to /sign-in. Fake GUIDs.
 *
 * v0.34 (A-02): before the cookie is cleared the cms ends every session of
 * the account (POST /api/me/sign-out with the session's JWT). The
 * destinations stay exactly as they were whatever the cms answers (only
 * Entra has an end-session redirect; a generic OIDC session and a local one
 * go to /sign-in); an unconfirmed revocation leaves the /sign-in notice
 * cookie, a confirmed one deletes a stale notice.
 */
const TENANT = "11111111-2222-4333-8444-555555555555";

const state = vi.hoisted(() => ({
  provider: undefined as string | undefined,
  jwt: "session.jwt" as string | null,
  redirects: [] as string[],
  signOuts: 0,
  /** What happened, in order: the revocation call and the cookie clearing. */
  steps: [] as string[],
  cookies: [] as { op: "set" | "delete"; name: string; value?: string; options?: unknown }[],
  cms: (): Promise<Response> => Promise.resolve(new Response(null, { status: 204 })),
}));

vi.mock("@/auth", () => ({
  signIn: vi.fn(),
  signOut: async () => {
    state.signOuts += 1;
    state.steps.push("signOut");
  },
}));
vi.mock("@/lib/session", () => ({
  getSession: async () => (state.provider ? { provider: state.provider, user: { id: 1 } } : null),
  getStrapiToken: async () => state.jwt,
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "intranet.example.test" }),
  cookies: async () => ({
    set: (name: string, value: string, options: unknown) =>
      state.cookies.push({ op: "set", name, value, options }),
    delete: (options: { name: string }) =>
      state.cookies.push({ op: "delete", name: options.name, options }),
  }),
}));
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  state.steps.push(`fetch ${url} ${String(new Headers(init?.headers).get("authorization"))}`);
  return state.cms();
});
vi.stubGlobal("fetch", fetchMock);
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
  state.steps = [];
  state.cookies = [];
  state.jwt = "session.jwt";
  state.cms = () => Promise.resolve(new Response(null, { status: 204 }));
  fetchMock.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    expect(target.searchParams.get("post_logout_redirect_uri")).toBe(
      "https://intranet.example.test/sign-in",
    );
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

describe("signOutAction ends every session of the account (v0.34)", () => {
  const ENTRA_END = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`;
  const destination = (url: string | undefined) => {
    const target = new URL(url ?? "about:blank", "https://intranet.example.test");
    return target.origin === "https://intranet.example.test"
      ? target.pathname
      : `${target.origin}${target.pathname}`;
  };
  const notice = () => state.cookies.filter((c) => c.name === "sinnlos-sign-out-unconfirmed");
  const DESTINATIONS = [
    ["microsoft-entra-id", ENTRA_END],
    ["oidc", "/sign-in"],
    ["local", "/sign-in"],
  ] as const;

  it("asks the cms with the session's JWT first, then clears the cookie", async () => {
    await signOutWith(ENTRA_ENV, "local");
    expect(state.steps).toEqual([
      "fetch http://localhost:1337/api/me/sign-out Bearer session.jwt",
      "signOut",
    ]);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST", cache: "no-store" });
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(DESTINATIONS)(
    "a confirmed sign-out of a %s session goes where it went before and leaves no notice",
    async (provider, target) => {
      expect(destination(await signOutWith(ENTRA_ENV, provider))).toBe(target);
      expect(state.signOuts).toBe(1);
      expect(notice()).toEqual([
        {
          op: "delete",
          name: "sinnlos-sign-out-unconfirmed",
          options: { name: "sinnlos-sign-out-unconfirmed", path: "/sign-in" },
        },
      ]);
    },
  );

  it.each([
    ["a 5xx", () => Promise.resolve(new Response("down", { status: 503 }))],
    [
      "a 401 (the JWT is already refused)",
      () => Promise.resolve(new Response("", { status: 401 })),
    ],
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
    ["a timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
  ])(
    "after %s it still signs out locally, keeps each destination and sets the notice",
    async (_, cms) => {
      state.cms = cms;
      for (const [provider, target] of DESTINATIONS) {
        state.cookies = [];
        expect(destination(await signOutWith(ENTRA_ENV, provider))).toBe(target);
        expect(notice()).toEqual([
          {
            op: "set",
            name: "sinnlos-sign-out-unconfirmed",
            value: "1",
            options: {
              httpOnly: true,
              sameSite: "lax",
              secure: true,
              path: "/sign-in",
              maxAge: 300,
            },
          },
        ]);
      }
      expect(state.signOuts).toBe(3);
    },
  );

  it("a session without a Strapi JWT cannot be ended on the cms: notice, no call", async () => {
    state.jwt = null;
    expect(await signOutWith(ENTRA_ENV, "local")).toBe("/sign-in");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notice().map((c) => c.op)).toEqual(["set"]);
  });

  it("without a session there is nothing to end: no call, no notice", async () => {
    expect(await signOutWith(ENTRA_ENV, undefined)).toBe("/sign-in");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notice().map((c) => c.op)).toEqual(["delete"]);
  });

  it("marks the notice Secure only on an https origin", async () => {
    state.cms = () => Promise.resolve(new Response("", { status: 500 }));
    await signOutWith({ ...ENTRA_ENV, AUTH_URL: "http://localhost:3000" }, "local");
    expect(notice()[0]?.options).toMatchObject({ secure: false });
  });
});
