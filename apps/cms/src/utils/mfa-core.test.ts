import { describe, expect, it } from "vitest";

import { Refusal, answerRefusals } from "./refusal";
import {
  hashRecoveryCode,
  newRecoveryCodes,
  parseMfaRequiredRoles,
  requiredMfa,
  roleRequiresMfa,
  secondFactorKind,
} from "./mfa-core";
import { isLocalUnbound, linkMatches, linkPurpose, linkUserId } from "./password-link";
import { accountMailReady, renderAccountMail } from "./account-mail";
import { createHash } from "node:crypto";

describe("MFA_REQUIRED_ROLES", () => {
  it("defaults to admin_role and editor when unset or empty; none = nobody", () => {
    expect(parseMfaRequiredRoles(undefined)).toEqual(["admin_role", "editor"]);
    expect(parseMfaRequiredRoles("  ")).toEqual(["admin_role", "editor"]);
    expect(parseMfaRequiredRoles("none")).toEqual([]);
    expect(parseMfaRequiredRoles("admin_role, department_head")).toEqual([
      "admin_role",
      "department_head",
    ]);
    expect(() => parseMfaRequiredRoles("admin,editor")).toThrow("unknown role admin");
  });

  it("separates the role rule from the enrollment (rev3 #2)", () => {
    const enrolledMember = { role: { type: "member" }, totpEnabledAt: new Date() };
    expect(roleRequiresMfa(enrolledMember, ["editor"])).toBe(false);
    expect(requiredMfa(enrolledMember, ["editor"])).toBe(true);
    expect(roleRequiresMfa({ role: { type: "editor" } }, ["editor"])).toBe(true);
  });
});

describe("recovery codes", () => {
  it("are ten distinct xxxx-xxxx-xxxx-xxxx codes of 80 bits (v0.30)", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    // 16 base32 characters = 80 bits.
    for (const code of codes) expect(code).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
    expect(hashRecoveryCode("abcd-efgh-ijkl-mnop")).toBe(hashRecoveryCode(" ABCDEFGHIJKLMNOP "));
  });

  it("recognises the codes in any spelling and refuses the 10-character ones of before v0.30", () => {
    expect(secondFactorKind("123456")).toBe("totp");
    for (const code of ["abcd-efgh-ijkl-mnop", "ABCDEFGHIJKLMNOP", "abcd efgh ijkl mnop"]) {
      expect(secondFactorKind(code), code).toBe("recovery");
    }
    for (const code of [
      "1234567",
      "ABCDE-23456",
      "abcde23456",
      "abcde-2345",
      "abcd-efgh-ijkl-mno",
      "abcd-efgh-ijkl-mnop-q",
      "abcde-23456-1",
    ]) {
      expect(secondFactorKind(code), code).toBeNull();
    }
  });
});

describe("set-password links", () => {
  const secret = "A".repeat(43);
  const hash = createHash("sha256").update(`${secret}:anna@example.com`, "utf8").digest("hex");
  const row = (over: Record<string, unknown> = {}) => ({
    id: 7,
    email: "anna@example.com",
    provider: "local",
    password: "$2a$10$hash",
    blocked: false,
    tokenVersion: 3,
    resetPasswordToken: `reset:${Math.floor(Date.now() / 1000) + 600}:3:${hash}`,
    ...over,
  });

  it("matches only the exact, current, unexpired link of a local unbound account", () => {
    const token = `7.${secret}`;
    expect(linkMatches(row(), token)).toBe(true);
    expect(linkMatches(row({ tokenVersion: 4 }), token)).toBe(false);
    expect(linkMatches(row({ blocked: true }), token)).toBe(false);
    expect(linkMatches(row({ microsoftOid: "oid" }), token)).toBe(false);
    expect(linkMatches(row({ password: null }), token)).toBe(false); // a reset needs a password
    expect(linkMatches(row({ resetPasswordToken: `reset:1:3:${hash}` }), token)).toBe(false);
    expect(linkMatches(row({ resetPasswordToken: "legacy-plugin-code" }), token)).toBe(false);
    expect(linkMatches(row(), `8.${secret}`)).toBe(false);
    expect(linkMatches(row(), `7.${"B".repeat(43)}`)).toBe(false);
    // Bound to the recipient: the same address in other spelling still matches, another does not.
    expect(linkMatches(row({ email: " Anna@Example.COM " }), token)).toBe(true);
    expect(linkMatches(row({ email: "anna@example.org" }), token)).toBe(false);
    expect(linkMatches(row({ email: null }), token)).toBe(false);
    expect(linkUserId("7.short")).toBeNull();
    expect(linkPurpose(row({ password: null }))).toBe("invite");
    expect(isLocalUnbound(row({ provider: "oidc" }))).toBe(false);
  });
});

describe("account mail", () => {
  it("needs SMTP, a sender and the web origin", () => {
    expect(accountMailReady({}).ok).toBe(false);
    expect(
      accountMailReady({
        SMTP_HOST: "h",
        SMTP_USER: "u",
        SMTP_PASS: "p",
        DIGEST_FROM: "x@y.z",
        PUBLIC_WEB_URL: "https://intranet.example.com/",
      }),
    ).toEqual({ ok: true, baseUrl: "https://intranet.example.com" });
  });

  it("renders the link once in text and escaped in html", () => {
    const mail = renderAccountMail("invite", "de", "https://i.example/set-password#1.x", "<Anna>");
    expect(mail.subject).toBe("Einladung ins Intranet");
    expect(mail.text).toContain("https://i.example/set-password#1.x");
    expect(mail.html).toContain("&lt;Anna&gt;");
  });
});

describe("answerRefusals", () => {
  it("answers a Refusal with its own status and code, rethrows anything else", async () => {
    const ctx = { status: 0, body: null as unknown };
    await answerRefusals(ctx, async () => {
      throw new Refusal(409, "already_enabled");
    });
    expect(ctx).toEqual({
      status: 409,
      body: {
        data: null,
        error: {
          status: 409,
          name: "ConflictError",
          message: "already_enabled",
          details: { code: "already_enabled" },
        },
      },
    });
    await expect(
      answerRefusals(ctx, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
