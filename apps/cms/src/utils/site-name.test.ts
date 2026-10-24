import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAccountMail } from "./account-mail";
import { TOTP_ISSUER, totpIssuer } from "./mfa";
import { siteName } from "./site-name";

/** v0.29 (S1): SITE_NAME in the cms: account-mail subjects and the TOTP issuer. */
describe("SITE_NAME in the cms", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads the shared rule and warns once for an invalid value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(siteName({})).toBeNull();
    expect(siteName({ SITE_NAME: " Musterfirma " })).toBe("Musterfirma");
    expect(siteName({ SITE_NAME: "x".repeat(41) })).toBeNull();
    expect(siteName({ SITE_NAME: "y".repeat(41) })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("keeps the account-mail subjects without a name and names the site with one", () => {
    const link = "https://i.example/set-password#1.x";
    expect(renderAccountMail("invite", "de", link, "Anna", null).subject).toBe(
      "Einladung ins Intranet",
    );
    expect(renderAccountMail("reset", "en", link, "Anna", null).subject).toBe(
      "Reset your password",
    );
    expect(renderAccountMail("invite", "de", link, "Anna", "Musterfirma").subject).toBe(
      "Einladung zu Musterfirma",
    );
    expect(renderAccountMail("invite", "en", link, "Anna", "Musterfirma").subject).toBe(
      "Invitation to Musterfirma",
    );
    expect(renderAccountMail("reset", "de", link, "Anna", "Musterfirma").subject).toBe(
      "Musterfirma: Passwort zurücksetzen",
    );
    vi.stubEnv("SITE_NAME", "Musterfirma");
    expect(renderAccountMail("reset", "en", link, "Anna").subject).toBe(
      "Musterfirma: Reset your password",
    );
  });

  it("names new TOTP enrolments after the site, without the label separator", () => {
    expect(totpIssuer(null)).toBe(TOTP_ISSUER);
    expect(TOTP_ISSUER).toBe("sinnlos");
    expect(totpIssuer("Musterfirma")).toBe("Musterfirma");
    expect(totpIssuer("Acme: Intranet")).toBe("Acme- Intranet");
  });
});
