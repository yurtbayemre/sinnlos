import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The v0.27 set-password link actions (lib/password-actions.ts): the
 * neutral reset request with its own limiter, and the set-password call
 * with the link token from the fragment, the internal secret, the code
 * mapping and the success redirect. Global fetch is stubbed; the limiter
 * and next/navigation are the real ones.
 */
let clientIp = "203.0.113.9";
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": clientIp }),
}));
vi.mock("@/i18n/locale", () => ({ getUserLocale: async () => "de" }));

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

const TOKEN = `42.${"a".repeat(43)}`;

async function load(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  const g = globalThis as {
    __sinnlosPasswordLinkRateLimiter?: unknown;
    __sinnlosSetPasswordRateLimiter?: unknown;
  };
  delete g.__sinnlosPasswordLinkRateLimiter;
  delete g.__sinnlosSetPasswordRateLimiter;
  for (const [key, value] of Object.entries({
    ENTRA_ENABLED: undefined,
    OIDC_ENABLED: undefined,
    AUTH_LOCAL_ENABLED: undefined,
    STRAPI_URL: "http://strapi.test",
    INTERNAL_UPLOAD_TOKEN: "internal-secret",
    ...env,
  })) {
    vi.stubEnv(key, value);
  }
  return import("./password-actions");
}

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

const cmsError = (code: string) =>
  new Response(
    JSON.stringify({
      data: null,
      error: { status: 400, name: "ValidationError", details: { code } },
    }),
    { status: 400 },
  );

beforeEach(() => {
  clientIp = "203.0.113.9";
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("requestPasswordReset", () => {
  it("posts the normalised address and locale with the internal secret, answers done", async () => {
    const { requestPasswordReset } = await load();
    await expect(requestPasswordReset({}, form({ email: " Ada@Example.TEST " }))).resolves.toEqual({
      done: true,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://strapi.test/api/auth/password/forgot");
    expect(new Headers(init?.headers).get("x-internal-token")).toBe("internal-secret");
    expect(JSON.parse(String(init?.body))).toEqual({ email: "ada@example.test", locale: "de" });
  });

  it("answers done the same way when the cms is unreachable", async () => {
    const { requestPasswordReset } = await load();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(requestPasswordReset({}, form({ email: "ada@example.test" }))).resolves.toEqual({
      done: true,
    });
  });

  it("asks nothing while local sign-in is off", async () => {
    vi.doMock("@/lib/auth-config", () => ({ LOCAL_ENABLED: false }));
    const { requestPasswordReset } = await load();
    vi.doUnmock("@/lib/auth-config");
    await expect(requestPasswordReset({}, form({ email: "ada@example.test" }))).resolves.toEqual({
      done: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a flood for one address with tooManyRequests", async () => {
    const { requestPasswordReset } = await load();
    for (let i = 0; i < 10; i++)
      await requestPasswordReset({}, form({ email: "ada@example.test" }));
    fetchMock.mockClear();
    await expect(requestPasswordReset({}, form({ email: "ada@example.test" }))).resolves.toEqual({
      error: "tooManyRequests",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A timed-out call may still have sent the mail: a slowed cms must not
  // lift either budget (security review of ec60008a).
  const timeout = async (): Promise<Response> => {
    throw new DOMException("timed out", "TimeoutError");
  };

  it("counts a request whose cms call times out toward the per-address budget", async () => {
    const { requestPasswordReset } = await load();
    fetchMock.mockImplementation(timeout);
    for (let ip = 1; ip <= 10; ip++) {
      clientIp = `198.51.100.${ip}`;
      await expect(requestPasswordReset({}, form({ email: "ada@example.test" }))).resolves.toEqual({
        done: true,
      });
    }
    fetchMock.mockClear();
    clientIp = "192.0.2.50";
    await expect(requestPasswordReset({}, form({ email: "ada@example.test" }))).resolves.toEqual({
      error: "tooManyRequests",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts a request whose cms call times out toward the per-IP budget", async () => {
    const { requestPasswordReset } = await load();
    fetchMock.mockImplementation(timeout);
    for (let i = 0; i < 10; i++)
      await requestPasswordReset({}, form({ email: `user${i}@example.test` }));
    fetchMock.mockClear();
    await expect(requestPasswordReset({}, form({ email: "ada@example.test" }))).resolves.toEqual({
      error: "tooManyRequests",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("setPasswordFromLink", () => {
  const good = {
    token: TOKEN,
    password: "a-long-new-passphrase",
    confirm: "a-long-new-passphrase",
  };

  it("sets the password and redirects to the sign-in notice", async () => {
    const { setPasswordFromLink } = await load();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const { redirect } = await vi.importActual<typeof import("next/navigation")>("next/navigation");
    let expected: unknown;
    try {
      redirect("/sign-in?passwordSet=1");
    } catch (e) {
      expected = e;
    }
    await expect(setPasswordFromLink({}, form(good))).rejects.toMatchObject({
      digest: (expected as { digest: string }).digest,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://strapi.test/api/auth/password/set");
    expect(new Headers(init?.headers).get("x-internal-token")).toBe("internal-secret");
    expect(JSON.parse(String(init?.body))).toEqual({
      token: TOKEN,
      password: "a-long-new-passphrase",
    });
  });

  it.each([
    ["a malformed token", { ...good, token: "42.short" }, "tokenInvalid"],
    ["different passwords", { ...good, confirm: "something-else-entirely" }, "passwordMismatch"],
    ["a short password", { ...good, password: "short", confirm: "short" }, "passwordTooShort"],
  ])("answers %s without a request", async (_label, fields, code) => {
    const { setPasswordFromLink } = await load();
    await expect(setPasswordFromLink({}, form(fields))).resolves.toEqual({ error: code });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["token_invalid", "tokenInvalid"],
    ["password_common", "passwordCommon"],
    ["password_tooShort", "passwordTooShort"],
    ["something_else", "setPasswordFailed"],
  ])("maps the cms code %s to %s", async (cmsCode, code) => {
    const { setPasswordFromLink } = await load();
    fetchMock.mockResolvedValue(cmsError(cmsCode));
    await expect(setPasswordFromLink({}, form(good))).resolves.toEqual({ error: code });
  });

  it("limits refused attempts per client IP, never per link: garbage for an id cannot lock its valid link", async () => {
    const { setPasswordFromLink } = await load();
    fetchMock.mockImplementation(async () => cmsError("token_invalid"));
    // Other IPs flood invalid tokens for user 42.
    for (let ip = 1; ip <= 30; ip++) {
      clientIp = `198.51.100.${ip}`;
      for (let i = 0; i < 3; i++) {
        await setPasswordFromLink({}, form({ ...good, token: `42.${"x".repeat(43)}` }));
      }
    }
    // The person's own valid link, from a fresh IP, still goes through.
    clientIp = "192.0.2.50";
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(setPasswordFromLink({}, form(good))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the forgot requests apart: a flood for the address set-password@<ip> never limits <ip>", async () => {
    const { requestPasswordReset, setPasswordFromLink } = await load();
    for (let ip = 1; ip <= 30; ip++) {
      clientIp = `198.51.100.${ip}`;
      for (let i = 0; i < 3; i++) {
        await requestPasswordReset({}, form({ email: "set-password@203.0.113.20" }));
        await requestPasswordReset({}, form({ email: "203.0.113.20@example.test" }));
      }
    }
    clientIp = "203.0.113.20";
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(setPasswordFromLink({}, form(good))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a flood from one IP with tooManyRequests", async () => {
    const { setPasswordFromLink } = await load();
    fetchMock.mockImplementation(async () => cmsError("token_invalid"));
    for (let i = 0; i < 10; i++) await setPasswordFromLink({}, form(good));
    fetchMock.mockClear();
    await expect(setPasswordFromLink({}, form(good))).resolves.toEqual({
      error: "tooManyRequests",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers setPasswordFailed for an outage", async () => {
    const { setPasswordFromLink } = await load();
    fetchMock.mockResolvedValue(new Response("", { status: 503 }));
    await expect(setPasswordFromLink({}, form(good))).resolves.toEqual({
      error: "setPasswordFailed",
    });
  });

  it("never counts an outage, a throttle or a timeout: a valid link works right after", async () => {
    const { setPasswordFromLink } = await load();
    const answers = [
      () => new Response("", { status: 503 }),
      () => new Response("", { status: 429 }),
      (): Response => {
        throw new DOMException("timed out", "TimeoutError");
      },
    ];
    for (let i = 0; i < 15; i++) {
      const answer = answers[i % answers.length]!;
      fetchMock.mockImplementationOnce(async () => answer());
      await expect(setPasswordFromLink({}, form(good))).resolves.toEqual({
        error: "setPasswordFailed",
      });
    }
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(setPasswordFromLink({}, form(good))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
