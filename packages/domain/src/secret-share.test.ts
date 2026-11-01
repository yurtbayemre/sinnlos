import { describe, expect, it } from "vitest";

import {
  SECRET_SHARE_CRYPTO,
  SECRET_SHARE_ERROR_CODES,
  SECRET_SHARE_REFUSALS,
  SECRET_SHARE_INDEXES,
  SECRET_SHARE_LIFETIMES,
  SECRET_SHARE_STATES,
  SECRET_SHARE_TABLE,
  SECRET_TEXT_MAX_BYTES,
  isSecretShareLifetime,
  isSecretText,
  secretShareAdditionalData,
  secretShareExpiresAt,
  secretShareLink,
} from "./secret-share.js";

const DOC = "a1b2c3d4e5f6g7h8i9j0k1l2";
const EXPIRES = new Date("2026-11-01T12:34:56.789Z");

/** The frozen parts: a change here breaks stored envelopes or the ops SQL. */
describe("secret share contract", () => {
  it("pins the states, lifetimes, codes and their statuses", () => {
    expect(SECRET_SHARE_STATES).toEqual([
      "pending",
      "retrieved",
      "revoked",
      "expired",
      "cancelled",
    ]);
    expect(SECRET_SHARE_LIFETIMES).toEqual(["1h", "24h"]);
    expect(SECRET_SHARE_ERROR_CODES).toEqual([
      "recipient",
      "text",
      "lifetime",
      "quota",
      "gone",
      "unavailable",
      "busy",
    ]);
    expect(SECRET_SHARE_REFUSALS).toEqual({
      recipient: { status: 400, code: "recipient" },
      text: { status: 400, code: "text" },
      lifetime: { status: 400, code: "lifetime" },
      quota: { status: 429, code: "quota" },
      gone: { status: 410, code: "gone" },
      partyIneligible: { status: 409, code: "unavailable" },
      noKey: { status: 503, code: "unavailable" },
      cancelled: { status: 410, code: "unavailable" },
      busy: { status: 503, code: "busy" },
    });
    // Every code has a cause.
    expect(new Set(Object.values(SECRET_SHARE_REFUSALS).map((r) => r.code))).toEqual(
      new Set(SECRET_SHARE_ERROR_CODES),
    );
  });

  it("pins the crypto parameters, the table and its indexes", () => {
    expect(SECRET_SHARE_CRYPTO).toEqual({
      hkdfHash: "sha256",
      hkdfSalt: "sinnlos",
      hkdfInfo: "sinnlos/secret-share/v1",
      keyBytes: 32,
      cipher: "aes-256-gcm",
      nonceBytes: 12,
      tagBytes: 16,
      envelopeVersion: "v1",
    });
    expect(SECRET_SHARE_TABLE).toBe("secret_shares");
    expect(SECRET_SHARE_INDEXES).toEqual([
      { attributes: ["documentId"], unique: true },
      { attributes: ["recipientId", "state"], unique: false },
      { attributes: ["senderId", "createdAt"], unique: false },
      { attributes: ["state", "expiresAt"], unique: false },
      { attributes: ["terminalAt"], unique: false },
    ]);
  });
});

describe("secretShareAdditionalData", () => {
  it("binds version, documentId, both ids and the expiry with milliseconds in UTC", () => {
    expect(
      secretShareAdditionalData({
        documentId: DOC,
        senderId: 7,
        recipientId: 12,
        expiresAt: EXPIRES,
      }),
    ).toBe(`v1|${DOC}|7|12|2026-11-01T12:34:56.789Z`);
    // Whole seconds keep their milliseconds: one spelling per instant.
    expect(
      secretShareAdditionalData({
        documentId: DOC,
        senderId: 1,
        recipientId: 2,
        expiresAt: new Date("2026-11-01T13:00:00+01:00"),
      }),
    ).toBe(`v1|${DOC}|1|2|2026-11-01T12:00:00.000Z`);
  });

  it("refuses a malformed field instead of binding an ambiguous string", () => {
    const ok = { documentId: DOC, senderId: 7, recipientId: 12, expiresAt: EXPIRES };
    expect(() =>
      secretShareAdditionalData({ ...ok, documentId: `${DOC.slice(0, 23)}|` }),
    ).toThrow();
    expect(() => secretShareAdditionalData({ ...ok, documentId: "" })).toThrow();
    expect(() => secretShareAdditionalData({ ...ok, senderId: 0 })).toThrow();
    expect(() => secretShareAdditionalData({ ...ok, recipientId: 1.5 })).toThrow();
    expect(() => secretShareAdditionalData({ ...ok, expiresAt: new Date("nope") })).toThrow();
    expect(() =>
      secretShareAdditionalData({ ...ok, expiresAt: "2026-11-01" as unknown as Date }),
    ).toThrow();
  });
});

describe("input rules", () => {
  it("accepts exactly the two lifetimes", () => {
    expect(isSecretShareLifetime("1h")).toBe(true);
    expect(isSecretShareLifetime("24h")).toBe(true);
    for (const value of ["7d", "1H", "", null, undefined, 3600, ["1h"]]) {
      expect(isSecretShareLifetime(value), JSON.stringify(value)).toBe(false);
    }
  });

  it("computes the expiry from the lifetime", () => {
    const now = new Date("2026-11-01T10:00:00.000Z");
    expect(secretShareExpiresAt(now, "1h").toISOString()).toBe("2026-11-01T11:00:00.000Z");
    expect(secretShareExpiresAt(now, "24h").toISOString()).toBe("2026-11-02T10:00:00.000Z");
  });

  it("limits the text in UTF-8 bytes, not characters, and keeps it unchanged", () => {
    expect(isSecretText("x".repeat(SECRET_TEXT_MAX_BYTES))).toBe(true);
    expect(isSecretText("x".repeat(SECRET_TEXT_MAX_BYTES + 1))).toBe(false);
    // "ä" is two bytes: 4096 fit, 4097 do not, though both are far below 8192 characters.
    expect(isSecretText("ä".repeat(4096))).toBe(true);
    expect(isSecretText("ä".repeat(4097))).toBe(false);
    // An emoji is four bytes.
    expect(isSecretText("🔑".repeat(2048))).toBe(true);
    expect(isSecretText("🔑".repeat(2048) + "x")).toBe(false);
    expect(isSecretText(" pass word ")).toBe(true);
  });

  it("refuses unpaired surrogates instead of storing U+FFFD, and keeps valid pairs", () => {
    expect(isSecretText("ab\ud800cd")).toBe(false);
    expect(isSecretText("ab\ud800")).toBe(false);
    expect(isSecretText("ab\udc00cd")).toBe(false);
    expect(isSecretText("\udc00\ud800")).toBe(false);
    expect(isSecretText(JSON.parse('"\\ud800"'))).toBe(false);
    expect(isSecretText("key \ud83d\udd11 ok")).toBe(true);
    expect(isSecretText("🔑")).toBe(true);
  });

  it("refuses a missing, blank or non-string text", () => {
    for (const value of ["", "   ", "\n\t", null, undefined, 42, { text: "x" }]) {
      expect(isSecretText(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("secretShareLink", () => {
  it("is the share's page", () => {
    expect(secretShareLink(DOC)).toBe(`/secrets/${DOC}`);
  });
});
