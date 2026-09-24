/**
 * Digest gate (issue #18, FX13): no owner-domain fallbacks — the link base
 * and the sender come from env only, and a missing one skips the run with an
 * error-level reason (also logged once at boot, FX13 review) instead of
 * mailing someone else's domain. The gate runs before any DB or SMTP access
 * (dark mode invariant).
 */
import { describe, expect, it, vi } from "vitest";

import { digestsEnabled, reportDigestConfig, sendDigests } from "./send-digests";

const SMTP = { SMTP_HOST: "mail.acme.io", SMTP_USER: "noreply@acme.io", SMTP_PASS: "app-pass" };
const FULL = {
  ...SMTP,
  PUBLIC_WEB_URL: "https://intranet.acme.io",
  DIGEST_FROM: "Intranet <noreply@acme.io>",
};

describe("digestsEnabled", () => {
  it("sends with complete env and uses PUBLIC_WEB_URL as the link base", () => {
    expect(digestsEnabled(FULL)).toEqual({ kind: "send", baseUrl: "https://intranet.acme.io" });
  });

  it("stays intentionally dark without SMTP or with the kill switch", () => {
    expect(digestsEnabled({}).kind).toBe("skip");
    expect(digestsEnabled({ ...FULL, DIGESTS_DISABLED: "1" })).toEqual({
      kind: "skip",
      reason: "DIGESTS_DISABLED=1",
    });
  });

  it("is misconfigured (not silently defaulted) without PUBLIC_WEB_URL or DIGEST_FROM", () => {
    const noUrl = digestsEnabled({ ...FULL, PUBLIC_WEB_URL: "" });
    expect(noUrl.kind).toBe("misconfigured");
    expect(noUrl.kind !== "send" && noUrl.reason).toContain("PUBLIC_WEB_URL");
    const noFrom = digestsEnabled({ ...FULL, DIGEST_FROM: " " });
    expect(noFrom.kind).toBe("misconfigured");
    expect(noFrom.kind !== "send" && noFrom.reason).toContain("DIGEST_FROM");
    expect(JSON.stringify([noUrl, noFrom])).not.toContain("yurtbay");
  });
});

describe("reportDigestConfig (boot-time echo)", () => {
  it("logs an error only when SMTP is set but the sender or link base is missing", () => {
    const error = vi.fn();
    reportDigestConfig({ error }, FULL);
    reportDigestConfig({ error }, {});
    reportDigestConfig(
      { error },
      { ...SMTP, PUBLIC_WEB_URL: "https://x.acme.io", DIGESTS_DISABLED: "1" },
    );
    expect(error).not.toHaveBeenCalled();

    reportDigestConfig({ error }, { ...SMTP, PUBLIC_WEB_URL: "https://x.acme.io" });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("DIGEST_FROM unset");
  });
});

describe("sendDigests gate", () => {
  it("logs an error and returns before any DB access when misconfigured", async () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, SMTP, { DIGESTS_DISABLED: "0" });
      delete process.env.PUBLIC_WEB_URL;
      process.env.DIGEST_FROM = "Intranet <noreply@acme.io>";
      const error = vi.fn();
      const warn = vi.fn();
      const info = vi.fn();
      const query = vi.fn();
      await sendDigests({ log: { error, warn, info }, db: { query } });
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain("PUBLIC_WEB_URL unset");
      expect(warn).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});
