import { CredentialsSignin, AuthError } from "next-auth";
import { describe, expect, it, vi } from "vitest";

import { logAuthError } from "./log-error";

/**
 * v0.34: a refused sign-in is one short line without a stack or the
 * identifier; every other Auth.js error keeps the default logger's output.
 */
const log = () => ({ error: vi.fn(), warn: vi.fn() });

class MfaRequired extends CredentialsSignin {
  code = "mfa_required";
}

describe("logAuthError", () => {
  it("writes one short warning for a refused sign-in", () => {
    const out = log();
    logAuthError(
      new CredentialsSignin("Read more at https://errors.authjs.dev#credentialssignin"),
      out,
    );
    expect(out.warn.mock.calls).toEqual([["[auth] sign-in refused (credentials)"]]);
    expect(out.error).not.toHaveBeenCalled();
  });

  it("names the refusal's code (the second factor), nothing else", () => {
    const out = log();
    logAuthError(new MfaRequired(), out);
    expect(out.warn.mock.calls).toEqual([["[auth] sign-in refused (mfa_required)"]]);
  });

  it("keeps the full output for every other error", () => {
    const out = log();
    class Configuration extends AuthError {
      static type = "Configuration";
    }
    const error = new Configuration("broken provider");
    logAuthError(error, out);
    expect(String(out.error.mock.calls[0]![0])).toContain("[auth][error]");
    expect(String(out.error.mock.calls[0]![0])).toContain("broken provider");
    expect(out.error.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(out.warn).not.toHaveBeenCalled();
  });

  it("prints the cause and its details like the default logger", () => {
    const out = log();
    const cause = new Error("db down");
    logAuthError(new Error("callback failed", { cause: { err: cause, provider: "oidc" } }), out);
    expect(out.error.mock.calls[1]).toEqual([
      expect.stringContaining("[auth][cause]"),
      cause.stack,
    ]);
    expect(out.error.mock.calls[2]![1]).toContain('"provider": "oidc"');
  });
});
