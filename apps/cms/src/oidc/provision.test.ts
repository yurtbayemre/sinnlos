import { describe, expect, it, vi } from "vitest";
import type { ExchangeHost } from "../idp/exchange-core";
import { parseOidcConfig, type OidcConfig } from "./config";
import type { OidcTokenResult } from "./id-token";
import {
  oidcUsername,
  readIdToken,
  resolveOidcRole,
  runOidcExchange,
  subjectRef,
} from "./provision";

/**
 * runOidcExchange up to the identity (v0.25.0): secret, body and the
 * verifier's refusals map to fixed answers before any database access. The
 * identity, role and profile paths run end to end in
 * integration/oidc-provision.integration.test.ts.
 */
const SECRET = "0123456789abcdef0123456789abcdef";

function settings(): OidcConfig {
  const parsed = parseOidcConfig({
    OIDC_ENABLED: "1",
    OIDC_ISSUER: "https://idp.example/realms/intranet",
    OIDC_CLIENT_ID: "sinnlos-web",
    OIDC_EXCHANGE_SECRET: SECRET,
  });
  if (!parsed.enabled) throw new Error("expected enabled");
  return parsed;
}

function host() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const query = vi.fn(() => {
    throw new Error("no database access expected");
  });
  return { host: { db: { query }, log } as unknown as ExchangeHost, log, query };
}

describe("runOidcExchange before the identity", () => {
  it("refuses a wrong secret (401) and a missing or oversized token (400) without verifying", async () => {
    const verify = vi.fn();
    const { host: h } = host();
    expect(
      await runOidcExchange(h, settings(), { secret: "wrong", body: { idToken: "x" } }, { verify }),
    ).toEqual({ status: 401, body: { error: "unauthorized" } });
    for (const body of [
      {},
      { idToken: "" },
      { idToken: 5 },
      { idToken: "x".repeat(16 * 1024 + 1) },
    ]) {
      expect(await runOidcExchange(h, settings(), { secret: SECRET, body }, { verify })).toEqual({
        status: 400,
        body: { error: "invalid" },
      });
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it("maps the verifier's refusals to fixed answers and touches no row", async () => {
    const cases: [OidcTokenResult, number, string][] = [
      [
        { ok: false, reason: "invalid", detail: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" },
        401,
        "invalid",
      ],
      [{ ok: false, reason: "unavailable", detail: "discovery HTTP 503" }, 503, "unavailable"],
      [
        { ok: false, reason: "email_unverified", detail: "email_verified" },
        403,
        "email_unverified",
      ],
      [{ ok: false, reason: "foreign_org", detail: "resourceowner" }, 403, "not_assigned"],
    ];
    for (const [result, status, error] of cases) {
      const { host: h, query } = host();
      const outcome = await runOidcExchange(
        h,
        settings(),
        { secret: SECRET, body: { idToken: "token" } },
        { verify: async () => result },
      );
      expect(outcome).toEqual({ status, body: { error } });
      expect(query).not.toHaveBeenCalled();
    }
  });
});

describe("OIDC helpers", () => {
  it("resolveOidcRole: the highest Intranet.* role, else the default", () => {
    expect(resolveOidcRole(["Intranet.Member", "Intranet.Admin", "other"], "deny")).toEqual({
      kind: "role",
      role: "admin_role",
      via: ["role:Intranet.Admin"],
    });
    expect(resolveOidcRole(["intranet.admin", "Admin"], "deny")).toEqual({ kind: "deny" });
    expect(resolveOidcRole([], "member")).toEqual({
      kind: "role",
      role: "member",
      via: ["default"],
    });
  });

  it("username and log reference are stable per identity and never show the subject", () => {
    const issuer = "https://idp.example/realms/intranet";
    expect(oidcUsername(issuer, "pat@example.test")).toMatch(/^oidc-[0-9a-f]{32}$/);
    expect(oidcUsername(issuer, "pat@example.test")).toBe(oidcUsername(issuer, "pat@example.test"));
    expect(oidcUsername(issuer, "a")).not.toBe(oidcUsername(`${issuer}/`, "a"));
    expect(subjectRef(issuer, "pat@example.test")).toMatch(/^[0-9a-f]{8}$/);
    expect(oidcUsername(issuer, "pat@example.test")).not.toContain("pat");
  });

  it("readIdToken takes a non-empty string of at most 16 KB", () => {
    expect(readIdToken({ idToken: "abc" })).toBe("abc");
    expect(readIdToken({ idToken: "x".repeat(16 * 1024) })).toHaveLength(16 * 1024);
    expect(readIdToken([])).toBeNull();
  });
});
