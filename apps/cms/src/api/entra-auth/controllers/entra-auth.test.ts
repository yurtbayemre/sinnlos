import { describe, expect, it, vi, type Mock } from "vitest";
import type { IdTokenResult } from "../../../entra/id-token";
import {
  MAX_TOKEN_BYTES,
  readTokens,
  secretMatches,
  type ExchangeDeps,
  type ExchangeHost,
} from "../../../entra/provision";
import controller, { handleExchange, type ExchangeContext } from "./entra-auth";

/**
 * The exchange's front door (D-ENTRA-01 spec D steps 1-4): 404 while off,
 * the shared secret, the body, the ID-token result, and 503 for anything
 * unexpected. The provisioning behind it runs against a real database in
 * integration/provision.integration.test.ts. Fake ids and secrets only.
 */
const SECRET = "0123456789abcdef0123456789abcdef";
const ENV = {
  ENTRA_ENABLED: "1",
  MS_TENANT_ID: "11111111-2222-4333-8444-555555555555",
  MS_CLIENT_ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  ENTRA_EXCHANGE_SECRET: SECRET,
};
const ID_TOKEN = "header.payload-ID-TOKEN-VALUE.signature";
const ACCESS_TOKEN = "graph-ACCESS-TOKEN-VALUE";

function context(
  headers: Record<string, string>,
  body: unknown,
): ExchangeContext & { notFound: ReturnType<typeof vi.fn> } {
  const ctx = {
    get: (field: string) => headers[field.toLowerCase()] ?? "",
    request: { body },
    status: 404,
    body: undefined as unknown,
    notFound: vi.fn(() => {
      ctx.status = 404;
      ctx.body = {
        data: null,
        error: { status: 404, name: "NotFoundError", message: "Not Found" },
      };
    }),
  };
  return ctx;
}

type LogSpy = Mock<(message: string) => void>;

function host(): ExchangeHost & { log: { info: LogSpy; warn: LogSpy; error: LogSpy } } {
  const unexpected = () => {
    throw new Error("no database access expected in this test");
  };
  return {
    db: { query: unexpected },
    documents: unexpected,
    plugin: unexpected,
    log: {
      info: vi.fn<(message: string) => void>(),
      warn: vi.fn<(message: string) => void>(),
      error: vi.fn<(message: string) => void>(),
    },
  };
}

const deps = (
  result: IdTokenResult | Error,
): ExchangeDeps & { verify: ReturnType<typeof vi.fn> } => ({
  verify: vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  }),
  graph: {
    fetch: (async () => {
      throw new Error("no Graph access expected in this test");
    }) as unknown as typeof fetch,
  },
});

const goodBody = { idToken: ID_TOKEN, accessToken: ACCESS_TOKEN };
const withSecret = { "x-entra-exchange-secret": SECRET };

/** Every log line of `h`, joined: tokens and secrets must never appear. */
const logText = (h: ReturnType<typeof host>) =>
  JSON.stringify([h.log.info.mock.calls, h.log.warn.mock.calls, h.log.error.mock.calls]);

describe("POST /api/auth/entra/exchange: front door", () => {
  it("answers 404 like a missing route while ENTRA_ENABLED is not '1'", async () => {
    for (const flag of [undefined, "0", "true"]) {
      const ctx = context(withSecret, goodBody);
      const h = host();
      const d = deps(new Error("must not verify"));
      await handleExchange(ctx, h, { ...ENV, ENTRA_ENABLED: flag }, d);
      expect(ctx.status).toBe(404);
      expect(ctx.notFound).toHaveBeenCalledTimes(1);
      expect(d.verify).not.toHaveBeenCalled();
      expect(logText(h)).toBe("[[],[],[]]");
    }
  });

  it("refuses a missing or wrong secret with 401 unauthorized before looking at the token", async () => {
    for (const headers of [
      {},
      { "x-entra-exchange-secret": "" },
      { "x-entra-exchange-secret": `${SECRET}x` },
      { "x-entra-exchange-secret": SECRET.toUpperCase() },
    ]) {
      const ctx = context(headers, goodBody);
      const d = deps(new Error("must not verify"));
      const h = host();
      await handleExchange(ctx, h, ENV, d);
      expect(ctx.status).toBe(401);
      expect(ctx.body).toEqual({ error: "unauthorized" });
      expect(d.verify).not.toHaveBeenCalled();
      expect(logText(h)).not.toContain(SECRET);
    }
  });

  it("refuses a malformed body with 400 invalid", async () => {
    const big = "x".repeat(MAX_TOKEN_BYTES + 1);
    for (const body of [
      undefined,
      null,
      "text",
      [],
      {},
      { idToken: ID_TOKEN },
      { idToken: 1, accessToken: ACCESS_TOKEN },
      { idToken: "", accessToken: ACCESS_TOKEN },
      { idToken: big, accessToken: ACCESS_TOKEN },
      { idToken: ID_TOKEN, accessToken: big },
    ]) {
      const ctx = context(withSecret, body);
      await handleExchange(ctx, host(), ENV, deps(new Error("must not verify")));
      expect(ctx.status, JSON.stringify(body)?.slice(0, 40)).toBe(400);
      expect(ctx.body).toEqual({ error: "invalid" });
    }
  });

  it("answers 401 invalid for a rejected ID token and 503 when the keys are unreachable", async () => {
    const invalid = context(withSecret, goodBody);
    const h1 = host();
    await handleExchange(
      invalid,
      h1,
      ENV,
      deps({ ok: false, reason: "invalid", detail: "ERR_JWT_EXPIRED" }),
    );
    expect([invalid.status, invalid.body]).toEqual([401, { error: "invalid" }]);
    expect(h1.log.warn).toHaveBeenCalledWith(
      "[entra] exchange refused: invalid ID token (ERR_JWT_EXPIRED)",
    );

    const down = context(withSecret, goodBody);
    const h2 = host();
    await handleExchange(
      down,
      h2,
      ENV,
      deps({ ok: false, reason: "unavailable", detail: "jwks TypeError" }),
    );
    expect([down.status, down.body]).toEqual([503, { error: "unavailable" }]);
    for (const h of [h1, h2]) {
      expect(logText(h)).not.toContain("ID-TOKEN-VALUE");
      expect(logText(h)).not.toContain("ACCESS-TOKEN-VALUE");
    }
  });

  it("maps an unexpected error to 503 unavailable with one error line", async () => {
    const ctx = context(withSecret, goodBody);
    const h = host();
    await handleExchange(ctx, h, ENV, deps(new Error("database is down")));
    expect([ctx.status, ctx.body]).toEqual([503, { error: "unavailable" }]);
    expect(h.log.error).toHaveBeenCalledWith("[entra] exchange failed: database is down");
  });

  it("answers 503 when the env turned invalid after the boot", async () => {
    const ctx = context(withSecret, goodBody);
    const h = host();
    await handleExchange(
      ctx,
      h,
      { ...ENV, MS_TENANT_ID: "common" },
      deps(new Error("must not verify")),
    );
    expect([ctx.status, ctx.body]).toEqual([503, { error: "unavailable" }]);
    expect(h.log.error.mock.calls[0][0]).toMatch(/MS_TENANT_ID/);
  });

  it("exposes exactly one action", () => {
    expect(Object.keys(controller)).toEqual(["exchange"]);
  });
});

describe("secretMatches / readTokens", () => {
  it("compares the secret exactly", () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(`${SECRET} `, SECRET)).toBe(false);
    expect(secretMatches(undefined, SECRET)).toBe(false);
    expect(secretMatches([SECRET], SECRET)).toBe(false);
    expect(secretMatches("", "")).toBe(false);
  });

  it("accepts two tokens up to 16 KB each", () => {
    const max = "y".repeat(MAX_TOKEN_BYTES);
    expect(readTokens({ idToken: max, accessToken: max, extra: 1 })).toEqual({
      idToken: max,
      accessToken: max,
    });
    // Counted in bytes: 8192 two-byte characters are 16 KB.
    expect(readTokens({ idToken: "ä".repeat(8192), accessToken: "a" })).not.toBeNull();
    expect(readTokens({ idToken: "ä".repeat(8193), accessToken: "a" })).toBeNull();
  });
});
