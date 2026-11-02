/**
 * Secret sharing (v0.35.0, docs/plan-v035-secret-sharing.md): one short
 * text from one employee to one colleague, opened once, then deleted. This
 * module is the contract the cms (storage, crypto, routes, janitor) and the
 * web (pages, Server Actions) build on: the vocabulary, the limits, the DTOs
 * and the frozen physical and cryptographic formats. A change to a frozen
 * part below breaks every stored share or every ops script that names it.
 *
 * The plaintext exists only in the create and reveal request handlers of the
 * cms and in the deliberate Server Action result of the web: only the
 * encrypted envelope ever reaches persistence, a log line or a subscriber.
 */
import { isDocumentId, isRowId } from "./entry-id.js";

// ---------------------------------------------------------------------------
// Vocabulary and limits.

/** A share's states. `pending` is the only one that changes; the others are final. */
export const SECRET_SHARE_STATES = [
  "pending",
  "retrieved",
  "revoked",
  "expired",
  "cancelled",
] as const;

export type SecretShareState = (typeof SECRET_SHARE_STATES)[number];

/** The lifetimes a sender can choose; nothing longer, no free date (plan §2). */
export const SECRET_SHARE_LIFETIMES = ["1h", "24h"] as const;

export type SecretShareLifetime = (typeof SECRET_SHARE_LIFETIMES)[number];

export const DEFAULT_SECRET_SHARE_LIFETIME: SecretShareLifetime = "1h";

export const SECRET_SHARE_LIFETIME_MS: Readonly<Record<SecretShareLifetime, number>> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

/**
 * How long an ended share's metadata stays after `terminalAt`: the sender
 * sees "retrieved" (never the content) for 7 days, then the janitor deletes
 * the row.
 */
export const SECRET_SHARE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The longest text, in UTF-8 bytes (checked in the web and the cms). */
export const SECRET_TEXT_MAX_BYTES = 8192;

/** Pending shares a sender may have open at once. */
export const SECRET_PENDING_PER_SENDER = 20;

/** Pending shares a recipient may have waiting at once. */
export const SECRET_PENDING_PER_RECIPIENT = 20;

/** Shares a sender may create in any 24 hours, in any state (refused when already this many). */
export const SECRET_CREATES_PER_DAY = 100;

/** The cms's in-process limiter: creates per minute per sender. */
export const SECRET_CREATES_PER_MINUTE = 10;

/** Sent shares per page of GET /api/secret-shares (`sentPage`, 1-based). */
export const SECRET_SENT_PAGE_SIZE = 20;

/**
 * The highest `sentPage` accepted. A sender holds at most a few hundred rows
 * (the daily cap over the lifetime plus the retention), far fewer pages.
 */
export const SECRET_SENT_MAX_PAGE = 100;

/** Most people one GET /api/secret-shares/recipients answers. */
export const SECRET_RECIPIENTS_LIMIT = 20;

/** The longest `q` of the recipients search, in characters. */
export const SECRET_RECIPIENTS_QUERY_MAX = 100;

/**
 * The shortest `ENCRYPTION_KEY` the module works with, in characters. With a
 * shorter one the cms logs one error line at boot and the module answers
 * `unavailable`; the rest of the intranet boots.
 */
export const SECRET_KEY_MIN_CHARS = 32;

/** Whether `value` is a lifetime a sender can choose. */
export function isSecretShareLifetime(value: unknown): value is SecretShareLifetime {
  return (SECRET_SHARE_LIFETIMES as readonly unknown[]).includes(value);
}

/** The expiry of a share created at `now` with `lifetime`. */
export function secretShareExpiresAt(now: Date, lifetime: SecretShareLifetime): Date {
  return new Date(now.getTime() + SECRET_SHARE_LIFETIME_MS[lifetime]);
}

/** An unpaired UTF-16 surrogate: a high one without a low one after it, or a low one alone. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Whether `text` can be shared: a string that is not blank, well-formed
 * UTF-16 and at most SECRET_TEXT_MAX_BYTES in UTF-8. Never trimmed or
 * otherwise changed: a password may start or end with a blank. An unpaired
 * surrogate (JSON "\ud800") is refused, not normalised: UTF-8 encoding would
 * store U+FFFD in its place, and the recipient would read another secret than
 * the one that was sent.
 */
export function isSecretText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !LONE_SURROGATE_RE.test(value) &&
    new TextEncoder().encode(value).length <= SECRET_TEXT_MAX_BYTES
  );
}

// ---------------------------------------------------------------------------
// Errors.

/**
 * The refusal codes (`error.details.code` of Strapi's error body; the
 * message is fixed and never echoes the text). A share the caller may not
 * see, or that does not exist, is a plain 404 without a code. The status
 * depends on the cause, not only on the code: SECRET_SHARE_REFUSALS.
 */
export const SECRET_SHARE_ERROR_CODES = [
  /** The recipient is missing, oneself, or not an active staff member. */
  "recipient",
  /** The text is missing, blank, not well-formed or longer than SECRET_TEXT_MAX_BYTES. */
  "text",
  /** The lifetime is not one of SECRET_SHARE_LIFETIMES. */
  "lifetime",
  /** A limit is reached: the minute limiter, a pending cap or the daily cap. */
  "quota",
  /** The share ended: retrieved, revoked, expired or cancelled. */
  "gone",
  /**
   * The share cannot be opened or created: the other party is not eligible
   * right now, the envelope did not open (the share is now cancelled), or
   * the module has no usable key.
   */
  "unavailable",
  /**
   * A lock, a deadlock or an unconfirmed COMMIT: nothing was confirmed and
   * no text left. The outcome is unknown, since a COMMIT can succeed with a
   * lost acknowledgement: after a reveal or a revoke the share is unchanged
   * or already ended; after a create no share exists, or a new pending share
   * and its notification do. The web says so and points the sender to the
   * sent list before sending again (no idempotency key).
   */
  "busy",
] as const;

export type SecretShareErrorCode = (typeof SECRET_SHARE_ERROR_CODES)[number];

/**
 * Every refusal the cms answers with a code, by cause: its HTTP status and
 * its code. `unavailable` has three causes with three statuses, so a client
 * that reads the status alone still tells "try later" from "never again".
 */
export const SECRET_SHARE_REFUSALS = {
  recipient: { status: 400, code: "recipient" },
  text: { status: 400, code: "text" },
  lifetime: { status: 400, code: "lifetime" },
  quota: { status: 429, code: "quota" },
  gone: { status: 410, code: "gone" },
  /** The other party is not eligible now; the share stays pending and may open after an unblock. */
  partyIneligible: { status: 409, code: "unavailable" },
  /** The module has no usable key (configuration): no create, no reveal. */
  noKey: { status: 503, code: "unavailable" },
  /** The envelope did not open, and the share's cancellation committed. */
  cancelled: { status: 410, code: "unavailable" },
  busy: { status: 503, code: "busy" },
} as const satisfies Readonly<Record<string, { status: number; code: SecretShareErrorCode }>>;

export type SecretShareRefusal = keyof typeof SECRET_SHARE_REFUSALS;

// ---------------------------------------------------------------------------
// DTOs. Fixed shapes: the cms builds them field by field from its own
// queries and returns nothing else (no populate, fields, filters or sort).
// Every answer is Strapi's `{ data: <DTO> }`. Instants are ISO 8601 UTC
// strings; `id` is the share's documentId.

/** POST /api/secret-shares. */
export interface SecretShareCreateInput {
  /** The recipient's user row id. */
  recipient: number;
  text: string;
  lifetime: SecretShareLifetime;
}

/** The answer of POST /api/secret-shares. */
export interface SecretShareCreated {
  id: string;
  expiresAt: string;
}

/** The other party of a share, as the blocked-user rule shows a person. */
export interface SecretSharePerson {
  displayName: string;
  blocked: boolean;
}

/** One share in a list, metadata only. */
export interface SecretShareSummary {
  id: string;
  /** The recipient of a sent share, the sender of a received one; null when the account is gone. */
  counterpart: SecretSharePerson | null;
  createdAt: string;
  expiresAt: string;
  /** The stored state: a share turns `cancelled` only after a committed transition. */
  state: SecretShareState;
  terminalAt: string | null;
  /** Pending, unexpired and both parties eligible now; false is "currently unavailable" while pending. */
  available: boolean;
}

/** GET /api/secret-shares?sentPage=. */
export interface SecretShareList {
  /** Pending shares to the caller that can be opened now. */
  received: SecretShareSummary[];
  /** The caller's shares, newest first: pending, and ended ones within their retention. */
  sent: SecretShareSummary[];
  /** Whether another `sentPage` follows. */
  hasMore: boolean;
}

/** GET /api/secret-shares/:id, for its sender or its recipient. */
export interface SecretShareDetail extends SecretShareSummary {
  /** The caller's side of the share. */
  direction: "sent" | "received";
}

/** The answer of POST /api/secret-shares/:id/reveal: once. */
export interface SecretShareRevealed {
  text: string;
}

/** The answer of POST /api/secret-shares/:id/revoke. */
export interface SecretShareRevoked {
  id: string;
}

/** One person of GET /api/secret-shares/recipients?q=: eligible staff, never the caller. */
export interface SecretShareRecipient {
  id: number;
  displayName: string;
  /** The department's name, or null. */
  department: string | null;
}

/** The answer of GET /api/secret-shares/recipients. */
export interface SecretShareRecipients {
  data: SecretShareRecipient[];
}

// ---------------------------------------------------------------------------
// Frozen: physical schema. The ops SQL (infra/restore-db.sh's purge,
// infra/diagnostics/secret-shares-rollback.sql) names these directly.
//
// Hidden content type api::secret-share.secret-share, table `secret_shares`,
// no draft/publish, no i18n. Columns: id, document_id (Strapi's, the opaque
// id in URLs), sender_id and recipient_id (plain integers, no relations, so
// no link tables), expires_at, state, terminal_at (set when the share
// leaves `pending`), envelope (text, NULL until the creation fills it and
// again once the share ended), created_at, updated_at.

export const SECRET_SHARE_TABLE = "secret_shares";

/**
 * The indexes, by attribute; the cms index builder
 * (bootstrap/document-indexes.ts) takes the column names from Strapi's
 * metadata, as for its other indexes.
 */
export const SECRET_SHARE_INDEXES: readonly { attributes: readonly string[]; unique: boolean }[] = [
  { attributes: ["documentId"], unique: true },
  { attributes: ["recipientId", "state"], unique: false },
  { attributes: ["senderId", "createdAt"], unique: false },
  { attributes: ["state", "expiresAt"], unique: false },
  { attributes: ["terminalAt"], unique: false },
];

// ---------------------------------------------------------------------------
// Frozen: crypto (plan §3.2). The cms implements it with Node's crypto.
//
//   key       HKDF-SHA256 (RFC 5869) over the raw UTF-8 bytes of the
//             ENCRYPTION_KEY string as configured (never base64- or
//             hex-decoded), salt = ASCII "sinnlos", info = ASCII
//             "sinnlos/secret-share/v1", 32 bytes; derived once per process.
//   cipher    AES-256-GCM, a fresh random 12-byte nonce per share, 16-byte tag.
//   envelope  "v1.<base64url nonce>.<base64url ciphertext||tag>" (no padding).
//   AAD       the UTF-8 bytes of secretShareAdditionalData(...).
//
// A share whose envelope does not open (another key, a tampered row, an
// unknown version) turns `cancelled` at the reveal attempt, never
// `retrieved`. Never rotate ENCRYPTION_KEY to purge shares: it also breaks
// the MFA secrets.

export const SECRET_SHARE_CRYPTO = {
  hkdfHash: "sha256",
  hkdfSalt: "sinnlos",
  hkdfInfo: "sinnlos/secret-share/v1",
  keyBytes: 32,
  cipher: "aes-256-gcm",
  nonceBytes: 12,
  tagBytes: 16,
  envelopeVersion: "v1",
} as const;

/** The fields the additional data binds an envelope to. */
export interface SecretShareBinding {
  documentId: string;
  senderId: number;
  recipientId: number;
  expiresAt: Date;
}

/**
 * The additional data of a share's envelope, as a string the cms encodes in
 * UTF-8: "v1|<documentId>|<senderId>|<recipientId>|<expiresAt>", the expiry
 * as ISO 8601 UTC with milliseconds. Moving a ciphertext to another row,
 * another pair of people or another expiry makes it fail to open. Throws on
 * a malformed field: no envelope is ever bound to an ambiguous string.
 */
export function secretShareAdditionalData(binding: SecretShareBinding): string {
  const { documentId, senderId, recipientId, expiresAt } = binding;
  if (!isDocumentId(documentId)) throw new Error("secret share: malformed documentId");
  if (!isRowId(senderId) || !isRowId(recipientId)) {
    throw new Error("secret share: malformed sender or recipient id");
  }
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    throw new Error("secret share: malformed expiresAt");
  }
  return [
    SECRET_SHARE_CRYPTO.envelopeVersion,
    documentId,
    String(senderId),
    String(recipientId),
    expiresAt.toISOString(),
  ].join("|");
}

// ---------------------------------------------------------------------------
// Frozen: the share's notification (plan §3.7).
//
// Created in the share's creation transaction, through the query engine
// (which schedules the recipient's live ping after the commit), built with
// the cms's buildNotification: type `secretShared`, recipient = the share's
// recipient, actor = the sender, titleParams.actor = the sender's display
// name, link = secretShareLink(documentId), no source. Never through the
// fan-out writer, never in the e-mail digest.
//
// One share has at most one such row, found by (type, link): the link holds
// the unique documentId. It is deleted in the same transaction that ends the
// share (reveal, revoke, expiry, cancel), with the share at anonymisation
// and orphan deletion, followed by an explicit after-commit ping. The
// restore purge and the rollback SQL delete every `secretShared` row.

export const SECRET_SHARED_NOTIFICATION_TYPE = "secretShared";

/** The web path of a share: its page, and its notification's link. */
export function secretShareLink(documentId: string): string {
  return `/secrets/${documentId}`;
}
