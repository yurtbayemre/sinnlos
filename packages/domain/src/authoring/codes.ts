/**
 * The refusal vocabulary of v2 authoring (deep-dive decision 06 §B1.4 and
 * §B5; batch 15 plan, contract K7). One list for the cms, which answers
 * these codes, and the web, which maps them to field texts
 * (infra/contracts.test.ts pins that every code has a text in both
 * languages).
 *
 * A refused write answers 400 `ValidationError` with
 *   - `details.keys`: every refused payload key (and a refused query key),
 *     sorted, the generic FX07 message naming them;
 *   - `details.codes`: `{ <key>: <code> }` for the keys whose refusal has a
 *     precise reason. A key in `keys` without a code means "invalid": a key
 *     the caller's class may not write, a query key, or a relation refusal.
 *
 * Two keys are not attributes:
 *   - `_form` (FORM_KEY): a refusal about the whole document
 *     (AUTHORING_FORM_CODES);
 *   - `status` (STATUS_KEY): the `?status=` of a create or update is
 *     missing (`required`) or not one the type takes (`invalid`).
 *
 * NO EXISTENCE ORACLE. A relation or media value the caller may not use
 * (missing, hidden, draft-only, another department's, foreign) always
 * answers `invalid` and nothing more, so the answers cannot tell them
 * apart. A department author's targeting outside their own department is
 * such a relation refusal; a field their class may not write (pinned,
 * requiresAck, publishAt, ...) is a refused key.
 */

/** The `details.codes` key of a refusal about the whole document. */
export const FORM_KEY = "_form";

/** The `details.keys`/`details.codes` key of a missing or refused `?status=`. */
export const STATUS_KEY = "status";

/** Codes of a refused field (the values of `details.codes`). */
export const AUTHORING_FIELD_CODES = [
  /** Not acceptable, no more precise reason (also every relation refusal). */
  "invalid",
  /** Missing or blank, but needed. */
  "required",
  /** Longer than the field allows (255 for a `string`, 200 000 for Markdown). */
  "tooLong",
  /** Not an instant with `Z` or an offset (`2026-10-01T07:00:00.000Z`). */
  "invalidInstant",
  /** Not a calendar date `YYYY-MM-DD`. */
  "invalidDate",
  /** Not an http(s) URL without credentials (or, for quick links, an internal path). */
  "invalidUrl",
  /** An event's end before its start. */
  "endBeforeStart",
  /** An all-day event's start or end not at a local midnight of APP_TIME_ZONE. */
  "notMidnight",
  /** `publishAt` less than a minute ahead. */
  "scheduleInPast",
  /** `unpublishAt` not after `publishAt`. */
  "unpublishBeforePublish",
  /** An announcement's `expiresAt` not after `publishAt`. */
  "expiresBeforePublish",
  /** An acknowledgement deadline without `requiresAck`. */
  "ackDeadlineWithoutAck",
  /** The draft cannot be published as it stands (the keys that block it). */
  "notPublishable",
  /** A lesson video URL that is no YouTube video (batch 17). */
  "videoUrlNotYoutube",
  /** A lesson quiz that does not validate (batch 17). */
  "quizInvalid",
  /** A poll's options or anonymity after its first vote. */
  "frozenAfterVotes",
  /**
   * A poll's `closesAt` once the retention removed its voter links (v0.28,
   * 30 days after the close): the poll cannot be reopened.
   */
  "votersRemoved",
  /** A wiki space's visibility without its target (batch 16). */
  "visibilityTarget",
  /** Fewer than MIN_POLL_OPTIONS or more than MAX_POLL_OPTIONS poll options. */
  "optionCount",
  /** Two poll options equal after trimming. */
  "optionDuplicate",
  /**
   * An upload that is not a format of the caller's profile, or not a clean
   * one (macro-enabled, template, slideshow, binary, a disguise; batch 16,
   * uploads.ts).
   */
  "fileType",
  /** An upload above its format's cap: 20 MB for PDF and Office, 5 MB for images (batch 16). */
  "fileTooLarge",
  /**
   * A wiki page's `parent` that would put the page below itself: the parent
   * is the page or one of its subpages (batch 16, key `parent`). Answered
   * for every writer, the admin panel included, when the write would close
   * a loop; a loop that existed before never blocks a save.
   */
  "parentCycle",
  /** A value another entry already has where it must be unique (a wiki space's `name`). */
  "taken",
  /** User administration (v0.23): one's own role or blocked state. */
  "selfChange",
  /** User administration: Entra's sync owns this field for this user. */
  "entraManaged",
  /** User administration: the manager would be the user or one of their reports. */
  "managerCycle",
] as const;

export type AuthoringFieldCode = (typeof AUTHORING_FIELD_CODES)[number];

/** Codes under FORM_KEY: about the whole document, not a field. */
export const AUTHORING_FORM_CODES = [
  /**
   * A discard where no published version exists: it would delete the
   * document. Department authors (and, from batch 17, course and lesson)
   * get this instead of the delete.
   */
  "neverPublished",
  /** A wiki space delete while it still has pages (batch 16). */
  "spaceNotEmpty",
  /** User administration: handing a role back to Entra for an account Entra does not sign in. */
  "notEntraBound",
] as const;

export type AuthoringFormCode = (typeof AUTHORING_FORM_CODES)[number];

/** Every code a v2 authoring 400 can carry. */
export const AUTHORING_CODES: readonly (AuthoringFieldCode | AuthoringFormCode)[] = [
  ...AUTHORING_FIELD_CODES,
  ...AUTHORING_FORM_CODES,
];

export type AuthoringCode = AuthoringFieldCode | AuthoringFormCode;

/** True for one of AUTHORING_CODES. */
export function isAuthoringCode(value: unknown): value is AuthoringCode {
  return (AUTHORING_CODES as readonly unknown[]).includes(value);
}

/** The `details` of an authoring 400: the refused keys and their codes. */
export interface AuthoringRefusalDetails {
  keys: string[];
  codes?: Partial<Record<string, AuthoringCode>>;
}
