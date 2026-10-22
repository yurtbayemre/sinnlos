import { describe, expect, it } from "vitest";
import { localSignInEnabled, refuseOidcBeforeAdapter } from "./sign-in-policy";

describe("localSignInEnabled (plan-oidc.md C1, same rule as the web)", () => {
  it("is on with AUTH_LOCAL_ENABLED=1 or without any identity provider", () => {
    const cases: [Record<string, string>, boolean][] = [
      [{}, true],
      [{ ENTRA_ENABLED: "1" }, false],
      [{ OIDC_ENABLED: "1" }, false],
      [{ ENTRA_ENABLED: "1", AUTH_LOCAL_ENABLED: "1" }, true],
      [{ OIDC_ENABLED: "1", AUTH_LOCAL_ENABLED: "1" }, true],
      [{ ENTRA_ENABLED: "true", OIDC_ENABLED: "0" }, true],
    ];
    for (const [env, expected] of cases) expect(localSignInEnabled(env)).toBe(expected);
  });
});

describe("refuseOidcBeforeAdapter", () => {
  it("refuses exactly OIDC_ENABLED=1", () => {
    expect(() => refuseOidcBeforeAdapter({ OIDC_ENABLED: "1" })).toThrow(/OIDC_ENABLED=1/);
    for (const flag of [undefined, "", "0", "true", " 1"]) {
      expect(() => refuseOidcBeforeAdapter({ OIDC_ENABLED: flag })).not.toThrow();
    }
  });
});
