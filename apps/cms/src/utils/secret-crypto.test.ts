import { createCipheriv, hkdfSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { secretShareAdditionalData } from "@sinnlos/domain";

import {
  configureShareKey,
  deriveShareKey,
  isUsableEncryptionKey,
  openEnvelope,
  sealEnvelope,
  shareKey,
} from "./secret-crypto";

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "Grüße-🔑-sinnlos-encryption-key-2026!";
const BINDING = {
  documentId: "a1b2c3d4e5f6g7h8i9j0k1l2",
  senderId: 7,
  recipientId: 12,
  expiresAt: new Date("2026-11-01T12:34:56.789Z"),
};

describe("deriveShareKey (the frozen HKDF contract)", () => {
  it("matches RFC 5869 test case 1 through the same call", () => {
    const okm = hkdfSync(
      "sha256",
      Buffer.from("0b".repeat(22), "hex"),
      Buffer.from("000102030405060708090a0b0c", "hex"),
      Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex"),
      42,
    );
    expect(Buffer.from(okm).toString("hex")).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });

  it("derives the pinned keys from the raw UTF-8 bytes of ENCRYPTION_KEY", () => {
    // Computed independently (HMAC-SHA256 extract and expand, salt "sinnlos",
    // info "sinnlos/secret-share/v1"); a change here breaks every stored share.
    expect(deriveShareKey(KEY_A).toString("hex")).toBe(
      "cc83caa3f4f26d264e77cd9a07ee91183445bf7c593482ee091167400bcf9b7f",
    );
    expect(deriveShareKey(KEY_B).toString("hex")).toBe(
      "917b3223aaf6f61aeaf67dd3c9b07205f3da3b329b368a4e5f726ba65305f049",
    );
  });

  it("never decodes the key string: a hex- or base64-looking key is its own characters", () => {
    const hexLooking = "00".repeat(16);
    expect(deriveShareKey(hexLooking)).not.toEqual(deriveShareKey("\u0000".repeat(16)));
    expect(deriveShareKey(hexLooking)).toHaveLength(32);
  });
});

describe("sealEnvelope / openEnvelope", () => {
  const key = deriveShareKey(KEY_A);

  it("round-trips any text, with a fresh nonce each time", () => {
    for (const text of ["hunter2", " pass word ", "ä🔑\n".repeat(100), "x".repeat(8192)]) {
      const envelope = sealEnvelope(key, text, BINDING);
      expect(envelope).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
      expect(envelope).not.toContain(text.trim());
      expect(openEnvelope(key, envelope, BINDING)).toBe(text);
    }
    expect(sealEnvelope(key, "same", BINDING)).not.toBe(sealEnvelope(key, "same", BINDING));
  });

  it("opens an envelope built by hand from the contract (format and additional data)", () => {
    const nonce = Buffer.alloc(12, 1);
    const gcm = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    gcm.setAAD(Buffer.from(secretShareAdditionalData(BINDING), "utf8"));
    const body = Buffer.concat([gcm.update("by hand", "utf8"), gcm.final(), gcm.getAuthTag()]);
    const envelope = `v1.${nonce.toString("base64url")}.${body.toString("base64url")}`;
    expect(openEnvelope(key, envelope, BINDING)).toBe("by hand");
  });

  it("refuses a tampered nonce, ciphertext or tag", () => {
    const envelope = sealEnvelope(key, "secret", BINDING);
    const [version, nonce, body] = envelope.split(".");
    const flip = (part: string, index: number) => {
      const bytes = Buffer.from(part, "base64url");
      bytes[index] ^= 1;
      return bytes.toString("base64url");
    };
    expect(openEnvelope(key, [version, flip(nonce, 0), body].join("."), BINDING)).toBeNull();
    expect(openEnvelope(key, [version, nonce, flip(body, 0)].join("."), BINDING)).toBeNull();
    const last = Buffer.from(body, "base64url").length - 1;
    expect(openEnvelope(key, [version, nonce, flip(body, last)].join("."), BINDING)).toBeNull();
  });

  it("refuses other additional data: another row, sender, recipient or expiry", () => {
    const envelope = sealEnvelope(key, "secret", BINDING);
    for (const other of [
      { ...BINDING, documentId: "z1b2c3d4e5f6g7h8i9j0k1l2" },
      { ...BINDING, senderId: 8 },
      { ...BINDING, recipientId: 7 },
      { ...BINDING, expiresAt: new Date(BINDING.expiresAt.getTime() + 1) },
    ]) {
      expect(openEnvelope(key, envelope, other)).toBeNull();
    }
  });

  it("refuses a wrong key, an unknown version and malformed strings", () => {
    const envelope = sealEnvelope(key, "secret", BINDING);
    expect(openEnvelope(deriveShareKey(KEY_B), envelope, BINDING)).toBeNull();
    expect(openEnvelope(key, envelope.replace(/^v1\./, "v2."), BINDING)).toBeNull();
    for (const bad of [
      null,
      42,
      "",
      "v1",
      "v1..",
      "v1.abc",
      `${envelope}.extra`,
      envelope.replace(/\.[^.]+$/, ".!!!!"),
      // Padding is not base64url as written.
      `${envelope}=`,
    ]) {
      expect(openEnvelope(key, bad, BINDING), String(bad)).toBeNull();
    }
  });
});

describe("the process key", () => {
  it("is null with a short or missing ENCRYPTION_KEY and says so once while the module is on", () => {
    const log = { error: vi.fn() };
    configureShareKey("short", true, log);
    expect(shareKey()).toBeNull();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0][0])).toMatch(/unavailable/);
    configureShareKey(undefined, true, log);
    expect(shareKey()).toBeNull();
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it("logs nothing while the module is off", () => {
    const log = { error: vi.fn() };
    configureShareKey("short", false, log);
    expect(shareKey()).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("derives the key of a usable ENCRYPTION_KEY once", () => {
    configureShareKey(KEY_A, true, { error: vi.fn() });
    expect(shareKey()?.toString("hex")).toBe(deriveShareKey(KEY_A).toString("hex"));
    expect(shareKey()).toBe(shareKey());
    expect(isUsableEncryptionKey("x".repeat(31))).toBe(false);
    expect(isUsableEncryptionKey("x".repeat(32))).toBe(true);
  });
});
