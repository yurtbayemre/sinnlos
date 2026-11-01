/**
 * The envelope of a secret share (v0.35.0, plan §3.2; the frozen contract is
 * SECRET_SHARE_CRYPTO and secretShareAdditionalData in @sinnlos/domain
 * secret-share.ts):
 *
 *   - key: HKDF-SHA256 over the raw UTF-8 bytes of ENCRYPTION_KEY as
 *     configured (never base64- or hex-decoded: the operator's string is the
 *     secret, whatever it looks like), salt "sinnlos", info
 *     "sinnlos/secret-share/v1", 32 bytes. A key of its own instead of
 *     Strapi's admin::encryption service, whose key is ENCRYPTION_KEY itself
 *     (the MFA secrets): one derivation per purpose;
 *   - AES-256-GCM, a fresh random 12-byte nonce per share, 16-byte tag;
 *   - "v1.<base64url nonce>.<base64url ciphertext||tag>";
 *   - the additional data binds the envelope to its row, both people and the
 *     expiry, so a ciphertext copied to another row does not open.
 *
 * openEnvelope never throws and never says why: another key, a tampered
 * part, an unknown version and a malformed string are all null, and the
 * caller cancels the share. Nothing here logs; the plaintext is a parameter
 * or a return value and nothing else.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import {
  SECRET_KEY_MIN_CHARS,
  SECRET_SHARE_CRYPTO,
  secretShareAdditionalData,
  type SecretShareBinding,
} from "@sinnlos/domain";

const { hkdfHash, hkdfSalt, hkdfInfo, keyBytes, cipher, nonceBytes, tagBytes, envelopeVersion } =
  SECRET_SHARE_CRYPTO;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Whether `value` can key the module: a string of at least SECRET_KEY_MIN_CHARS characters. */
export function isUsableEncryptionKey(value: unknown): value is string {
  return typeof value === "string" && Array.from(value).length >= SECRET_KEY_MIN_CHARS;
}

/** The share key of an ENCRYPTION_KEY (HKDF, see the module comment). */
export function deriveShareKey(encryptionKey: string): Buffer {
  return Buffer.from(
    hkdfSync(
      hkdfHash,
      Buffer.from(encryptionKey, "utf8"),
      Buffer.from(hkdfSalt, "ascii"),
      Buffer.from(hkdfInfo, "ascii"),
      keyBytes,
    ),
  );
}

const aad = (binding: SecretShareBinding) =>
  Buffer.from(secretShareAdditionalData(binding), "utf8");

/** The envelope of `text` for the share `binding` describes. */
export function sealEnvelope(key: Buffer, text: string, binding: SecretShareBinding): string {
  const nonce = randomBytes(nonceBytes);
  const gcm = createCipheriv(cipher, key, nonce, { authTagLength: tagBytes });
  gcm.setAAD(aad(binding));
  const body = Buffer.concat([gcm.update(text, "utf8"), gcm.final(), gcm.getAuthTag()]);
  return [envelopeVersion, nonce.toString("base64url"), body.toString("base64url")].join(".");
}

/** Strict base64url (no padding, canonical): a re-encoding must give the same string. */
function decode(part: string): Buffer | null {
  if (!BASE64URL_RE.test(part)) return null;
  const bytes = Buffer.from(part, "base64url");
  return bytes.toString("base64url") === part ? bytes : null;
}

/** The text of an envelope, or null when it does not open (see the module comment). */
export function openEnvelope(
  key: Buffer,
  envelope: unknown,
  binding: SecretShareBinding,
): string | null {
  if (typeof envelope !== "string") return null;
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== envelopeVersion) return null;
  const nonce = decode(parts[1]);
  const body = decode(parts[2]);
  if (!nonce || nonce.length !== nonceBytes || !body || body.length <= tagBytes) return null;
  try {
    const gcm = createDecipheriv(cipher, key, nonce, { authTagLength: tagBytes });
    gcm.setAAD(aad(binding));
    gcm.setAuthTag(body.subarray(body.length - tagBytes));
    const text = Buffer.concat([gcm.update(body.subarray(0, body.length - tagBytes)), gcm.final()]);
    return text.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * The process's share key: derived once, at the first use after
 * configureShareKey(). Null while the module has no usable key.
 */
let configured: string | null = null;
let derived: Buffer | null = null;

/**
 * bootstrap(): takes ENCRYPTION_KEY as Strapi's admin config holds it. A
 * missing or short key leaves the module without a key: one error line at
 * boot (only while the module is on), `unavailable` at every create and
 * reveal; the rest of the intranet boots.
 */
export function configureShareKey(
  encryptionKey: unknown,
  moduleOn: boolean,
  log: { error(message: string): void },
): void {
  derived = null;
  configured = isUsableEncryptionKey(encryptionKey) ? encryptionKey : null;
  if (configured === null && moduleOn) {
    log.error(
      `[secrets] ENCRYPTION_KEY is shorter than ${SECRET_KEY_MIN_CHARS} characters: secret sharing answers "unavailable" (no create, no reveal)`,
    );
  }
}

/** The share key, or null without a usable ENCRYPTION_KEY. */
export function shareKey(): Buffer | null {
  if (configured === null) return null;
  derived ??= deriveShareKey(configured);
  return derived;
}
