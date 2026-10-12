import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sign-in and register actions answer machine codes (AC02); the forms
 * translate them (lib/auth/form-messages.ts). No Strapi message reaches the
 * UI. `@/auth` signIn is mocked to reject the way Auth.js' raw signIn()
 * does (it rethrows CredentialsSignin subclasses, @auth/core index.js; the
 * real authorize() → 429 path is pinned in auth.test.ts). The register
 * action's request is answered by a stubbed global fetch; the login limiter
 * is the real one (FX39: reserved before the request, settled after it).
 * next/navigation is the real module, so the success redirect is a genuine
 * NEXT_REDIRECT.
 */
const signInMock = vi.fn<(provider: string, options: unknown) => Promise<never>>();
vi.mock("@/auth", () => ({
  signIn: (provider: string, options: unknown) => signInMock(provider, options),
  signOut: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getSession: async () => null }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

/** Fresh actions (and limiter) under the given env: auth-config reads it at import. */
async function load(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  delete (globalThis as { __sinnlosLoginRateLimiter?: unknown }).__sinnlosLoginRateLimiter;
  for (const [key, value] of Object.entries({
    ENTRA_ENABLED: undefined,
    AUTH_LOCAL_ENABLED: undefined,
    LOCAL_REGISTRATION: "1",
    STRAPI_URL: "http://strapi.test",
    ...env,
  })) {
    vi.stubEnv(key, value);
  }
  const actions = await import("./auth-actions");
  const { loginRateLimiter } = await import("./login-rate-limit");
  // The error classes of THIS module graph (resetModules re-evaluates
  // next-auth, and instanceof checks need the same class).
  const { CredentialsSignin } = await import("next-auth");
  const { LoginBlockedSignIn, StrapiRateLimitedSignIn } = await import("./auth-errors");
  return {
    ...actions,
    loginRateLimiter,
    CredentialsSignin,
    LoginBlockedSignIn,
    StrapiRateLimitedSignIn,
  };
}

/** The error Next's own redirect() throws, as Auth.js' signIn() does on success. */
async function successRedirect(): Promise<unknown> {
  const { redirect } = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  try {
    redirect("/");
  } catch (error) {
    return error;
  }
  throw new Error("redirect() did not throw");
}

const signInForm = (identifier = "ada@example.test") => {
  const data = new FormData();
  data.set("identifier", identifier);
  data.set("password", "pw");
  data.set("from", "/");
  return data;
};

const registerForm = (fields: Record<string, string> = {}) => {
  const data = new FormData();
  const values = { username: "Ada", email: "ada@example.test", password: "secret-pw", ...fields };
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

/** Strapi's register refusal: `{ data: null, error: { status, name, message } }`. */
const strapiRefusal = (status: number, message: string) =>
  new Response(
    JSON.stringify({ data: null, error: { status, name: "ApplicationError", message } }),
    { status, headers: { "content-type": "application/json" } },
  );

// The first import transforms next-auth and @auth/core (inlined, see
// vitest.config.ts); under a full parallel run that cold import can eat a
// test's 5 s budget. Pay it once here, under the hook timeout (the
// auth.test.ts pattern); load() then re-evaluates cheaply.
beforeAll(async () => {
  await load();
}, 30_000);

beforeEach(() => {
  signInMock.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ jwt: "x", user: { id: 9 } })));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("signInWithCredentials", () => {
  it("maps Strapi's throttle (429) to rateLimited, echoing the identifier", async () => {
    const { signInWithCredentials, StrapiRateLimitedSignIn } = await load();
    signInMock.mockRejectedValue(new StrapiRateLimitedSignIn());
    await expect(signInWithCredentials({}, signInForm())).resolves.toEqual({
      error: "rateLimited",
      values: { identifier: "ada@example.test" },
    });
  });

  it("maps an attempt the limiter refused inside authorize() to rateLimited", async () => {
    // The read-only pre-check passed, but parallel attempts in flight took
    // the last places before authorize() reserved one (FX39): authorize()
    // throws LoginBlockedSignIn, which is not a wrong password.
    const { signInWithCredentials, LoginBlockedSignIn, loginRateLimiter } = await load();
    signInMock.mockRejectedValue(new LoginBlockedSignIn());
    expect(loginRateLimiter.isBlocked("203.0.113.7", "ada@example.test")).toBe(false);
    await expect(signInWithCredentials({}, signInForm())).resolves.toEqual({
      error: "rateLimited",
      values: { identifier: "ada@example.test" },
    });
    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("maps wrong credentials to invalidCredentials", async () => {
    const { signInWithCredentials, CredentialsSignin } = await load();
    signInMock.mockRejectedValue(new CredentialsSignin());
    await expect(signInWithCredentials({}, signInForm())).resolves.toEqual({
      error: "invalidCredentials",
      values: { identifier: "ada@example.test" },
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("answers an unexpected sign-in error like wrong credentials, and logs it", async () => {
    const { signInWithCredentials } = await load();
    signInMock.mockRejectedValue(new Error("Configuration"));
    await expect(signInWithCredentials({}, signInForm())).resolves.toMatchObject({
      error: "invalidCredentials",
    });
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("answers rateLimited without a sign-in while the limiter blocks the source", async () => {
    const { signInWithCredentials, loginRateLimiter } = await load();
    for (let i = 0; i < 10; i++) {
      const ticket = loginRateLimiter.tryAcquire(`10.0.0.${i}`, "ada@example.test");
      if (ticket !== "blocked") loginRateLimiter.settle(ticket, "failure");
    }
    await expect(signInWithCredentials({}, signInForm("Ada@Example.test"))).resolves.toMatchObject({
      error: "rateLimited",
    });
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("rethrows the NEXT_REDIRECT that signals a successful sign-in", async () => {
    const { signInWithCredentials } = await load();
    const redirect = await successRedirect();
    signInMock.mockRejectedValue(redirect);
    await expect(signInWithCredentials({}, signInForm())).rejects.toBe(redirect);
  });
});

describe("registerLocalAccount", () => {
  it("creates the account (client IP forwarded), then signs in", async () => {
    const { registerLocalAccount } = await load();
    const redirect = await successRedirect();
    signInMock.mockRejectedValue(redirect);
    await expect(registerLocalAccount({}, registerForm())).rejects.toBe(redirect);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://strapi.test/api/auth/local/register");
    expect(new Headers(init?.headers).get("x-forwarded-for")).toBe("203.0.113.7");
    expect(JSON.parse(String(init?.body))).toEqual({
      username: "Ada",
      email: "ada@example.test",
      password: "secret-pw",
      displayName: "Ada",
    });
    expect(signInMock).toHaveBeenCalledWith("local", {
      identifier: "ada@example.test",
      password: "secret-pw",
      redirectTo: "/",
    });
  });

  it("answers registrationDisabled without a request while registration is off", async () => {
    const { registerLocalAccount } = await load({ LOCAL_REGISTRATION: undefined });
    await expect(registerLocalAccount({}, registerForm())).resolves.toEqual({
      error: "registrationDisabled",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no name", { username: "  " }, "missingFields"],
    ["no email", { email: "" }, "missingFields"],
    ["no password", { password: "" }, "missingFields"],
    ["a short password", { password: "12345" }, "passwordTooShort"],
  ])("answers %s locally, echoing the values but never the password", async (_l, fields, code) => {
    const { registerLocalAccount } = await load();
    const result = await registerLocalAccount({}, registerForm(fields));
    expect(result.error).toBe(code);
    expect(JSON.stringify(result)).not.toContain("secret-pw");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a taken email", "emailTaken", strapiRefusal(400, "Email or Username are already taken")],
    [
      "registration off in the cms",
      "registrationDisabled",
      strapiRefusal(400, "Register action is currently disabled"),
    ],
    ["Strapi's throttle", "rateLimited", strapiRefusal(429, "Too many requests, please try later")],
    ["another refusal", "registrationFailed", strapiRefusal(400, "Invalid parameters: role")],
    ["an outage", "registrationFailed", new Response("<html>502</html>", { status: 502 })],
  ])("maps %s to %s and never passes Strapi's message through", async (_l, code, answer) => {
    const { registerLocalAccount } = await load();
    fetchMock.mockResolvedValue(answer);
    const result = await registerLocalAccount({}, registerForm());
    expect(result).toEqual({ error: code, values: { username: "Ada", email: "ada@example.test" } });
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("answers registrationFailed for a network error", async () => {
    const { registerLocalAccount } = await load();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(registerLocalAccount({}, registerForm())).resolves.toMatchObject({
      error: "registrationFailed",
    });
  });

  it("answers accountCreatedSignInManually when the sign-in after it fails", async () => {
    const { registerLocalAccount, CredentialsSignin } = await load();
    signInMock.mockRejectedValue(new CredentialsSignin());
    await expect(registerLocalAccount({}, registerForm())).resolves.toMatchObject({
      error: "accountCreatedSignInManually",
    });
  });

  it("counts a refused registration against the limiter, an outage not (FX39)", async () => {
    const { registerLocalAccount, loginRateLimiter } = await load();
    fetchMock.mockImplementation(async () => new Response("", { status: 503 }));
    for (let i = 0; i < 12; i++) await registerLocalAccount({}, registerForm());
    expect(loginRateLimiter.size()).toBe(0);
    fetchMock.mockImplementation(async () =>
      strapiRefusal(400, "Email or Username are already taken"),
    );
    for (let i = 0; i < 10; i++) await registerLocalAccount({}, registerForm());
    expect(console.warn).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    await expect(registerLocalAccount({}, registerForm())).resolves.toMatchObject({
      error: "rateLimited",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
