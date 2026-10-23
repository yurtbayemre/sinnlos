/**
 * TOTP (RFC 6238 over RFC 4226 HOTP) for the second factor of local
 * accounts (v0.27): HMAC-SHA1, 6 digits, 30-second steps, one step of drift
 * either way. Plus RFC 4648 base32 (no padding), the format authenticator
 * apps take the secret in. node:crypto only.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Bytes of a new secret (RFC 4226 recommends 160 bits). */
export const TOTP_SECRET_BYTES = 20;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The bytes of a base32 string (case-insensitive, spaces ignored), or null when it is none. */
export function base32Decode(input: string): Buffer | null {
  const clean = input.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z2-7]+$/.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret, base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/** The time step of `atMs`. */
export function totpStep(atMs: number = Date.now()): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

/** HOTP(secret, counter) as a zero-padded decimal string (RFC 4226 §5.3). */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(message).digest();
  const offset = mac[mac.length - 1] & 15;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

/**
 * The step `code` is valid for (the current one, or one step either way),
 * or null. Constant-time per comparison; the caller refuses a step at or
 * below the last one it accepted (replay).
 */
export function matchTotp(secret: Buffer, code: string, atMs: number = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(atMs);
  let match: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code))) match = step;
  }
  return match;
}

/** The otpauth:// URI authenticator apps read from a QR code. */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
