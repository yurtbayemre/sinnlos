import { describe, expect, it, vi } from "vitest";
import {
  ENTRA_SIGN_IN_ERRORS,
  EXCHANGE_PATH,
  EXCHANGE_RETRY_DELAY_MS,
  EXCHANGE_TIMEOUT_MS,
  exchangeEntraSignIn,
  signInErrorKey,
  type ExchangeOptions,
} from "./entra-exchange";

/**
 * The web half of the Entra exchange (D-ENTRA-01 spec C): POST with the
 * shared secret, 10 s per attempt, one retry after 500 ms only on a network
 * error or 502/503/504, and a typed result. Fake tokens only.
 */
const TOKENS = { idToken: "id.TOKEN-VALUE.sig", accessToken: "ACCESS-TOKEN-VALUE" };
const OK = {
  jwt: "a.b.c",
  expiresAt: 1_900_000_000,
  user: { id: 42, displayName: "Grace", email: "grace@example.test" },
};

/** A fresh Response per call (a Response body can be read only once). */
type Answer = () => Response | Promise<Response>;

function harness(...answers: Answer[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const answer = answers.length > 1 ? answers.shift()! : answers[0];
    return answer();
  });
  const log = { error: vi.fn(), warn: vi.fn() };
  const options: ExchangeOptions = {
    strapiUrl: "http://cms:1337/",
    secret: "shared-exchange-secret-0123456789abcdef",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    retryDelayMs: 1,
    log,
  };
  return { calls, options, log };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

describe("exchangeEntraSignIn", () => {
  it("POSTs both tokens as JSON with the secret header, to the cms, once", async () => {
    const { calls, options } = harness(() => json(OK));
    expect(await exchangeEntraSignIn(TOKENS, options)).toEqual({ ok: true, data: OK });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls;
    expect(url).toBe(`http://cms:1337${EXCHANGE_PATH}`);
    expect(url).not.toContain("TOKEN");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "x-entra-exchange-secret": "shared-exchange-secret-0123456789abcdef",
    });
    expect(JSON.parse(String(init.body))).toEqual(TOKENS);
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses 10 s per attempt and 500 ms before the retry by default", () => {
    expect(EXCHANGE_TIMEOUT_MS).toBe(10_000);
    expect(EXCHANGE_RETRY_DELAY_MS).toBe(500);
  });

  it.each([
    [409, "account_exists"],
    [403, "not_assigned"],
    [403, "blocked"],
    [401, "invalid"],
    [400, "invalid"],
  ] as const)("passes a %i %s through, without a retry", async (status, code) => {
    const { calls, options, log } = harness(() => json({ error: code }, status));
    expect(await exchangeEntraSignIn(TOKENS, options)).toEqual({ ok: false, code });
    expect(calls).toHaveLength(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("maps 401 unauthorized, 404 and a 500 to unavailable with an error line, without a retry", async () => {
    for (const response of [
      () => json({ error: "unauthorized" }, 401),
      () => json({ data: null, error: { status: 404 } }, 404),
      () => json({}, 500),
      () => new Response("<html>", { status: 500 }),
    ]) {
      const { calls, options, log } = harness(response);
      expect(await exchangeEntraSignIn(TOKENS, options)).toEqual({
        ok: false,
        code: "unavailable",
      });
      expect(calls).toHaveLength(1);
      expect(log.error).toHaveBeenCalledTimes(1);
    }
    const secretMismatch = harness(() => json({ error: "unauthorized" }, 401));
    await exchangeEntraSignIn(TOKENS, secretMismatch.options);
    expect(secretMismatch.log.error.mock.calls[0][0]).toMatch(/ENTRA_EXCHANGE_SECRET differs/);
  });

  it.each([502, 503, 504])("retries a %i once", async (status) => {
    const failing = harness(() => json({ error: "unavailable" }, status));
    expect(await exchangeEntraSignIn(TOKENS, failing.options)).toEqual({
      ok: false,
      code: "unavailable",
    });
    expect(failing.calls).toHaveLength(2);

    const recovering = harness(
      () => json({ error: "unavailable" }, status),
      () => json(OK),
    );
    expect(await exchangeEntraSignIn(TOKENS, recovering.options)).toEqual({ ok: true, data: OK });
    expect(recovering.calls).toHaveLength(2);
  });

  it("retries a network error once, then gives up as unavailable", async () => {
    const down = harness(async () => Promise.reject(new TypeError("fetch failed")));
    expect(await exchangeEntraSignIn(TOKENS, down.options)).toEqual({
      ok: false,
      code: "unavailable",
    });
    expect(down.calls).toHaveLength(2);
    expect(down.log.error.mock.calls[0][0]).toMatch(/unreachable \(TypeError\)/);
  });

  it("gives up after a timeout on both attempts", async () => {
    const hanging = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const { options, log } = harness(() => json(OK));
    const fetchImpl = vi.fn(hanging);
    const result = await exchangeEntraSignIn(TOKENS, {
      ...options,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
    });
    expect(result).toEqual({ ok: false, code: "unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(log.error.mock.calls[0][0]).toMatch(/unreachable \(timeout\)/);
  });

  it("treats a 200 without a usable body as unavailable", async () => {
    for (const body of [{}, { jwt: "x" }, { jwt: "x", expiresAt: 1, user: {} }, "text"]) {
      const { options } = harness(() => json(body));
      expect(await exchangeEntraSignIn(TOKENS, options), JSON.stringify(body)).toEqual({
        ok: false,
        code: "unavailable",
      });
    }
  });

  it("never logs a token", async () => {
    const answers = [
      () => json({ error: "unauthorized" }, 401),
      () => json({ error: "account_exists" }, 409),
      () => json({}, 503),
    ];
    for (const answer of answers) {
      const { options, log } = harness(answer);
      await exchangeEntraSignIn(TOKENS, options);
      const logged = JSON.stringify([log.error.mock.calls, log.warn.mock.calls]);
      expect(logged).not.toContain("TOKEN-VALUE");
      expect(logged).not.toContain("shared-exchange-secret");
    }
  });
});

describe("signInErrorKey", () => {
  it("explains every entra_* code and nothing else by name", () => {
    expect(ENTRA_SIGN_IN_ERRORS).toEqual([
      "entra_tenant",
      "entra_account_exists",
      "entra_not_assigned",
      "entra_blocked",
      "entra_invalid",
      "entra_unavailable",
    ]);
    for (const code of ENTRA_SIGN_IN_ERRORS) expect(signInErrorKey(code)).toBe(code);
    for (const other of [
      "AccessDenied",
      "Configuration",
      "CredentialsSignin",
      "entra_",
      "<script>",
    ]) {
      expect(signInErrorKey(other)).toBe("signInFailed");
    }
    expect(signInErrorKey(undefined)).toBeNull();
    expect(signInErrorKey("")).toBeNull();
    expect(signInErrorKey(["entra_blocked", "x"])).toBe("entra_blocked");
  });
});
