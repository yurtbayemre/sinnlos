/**
 * The error contract of the /manage forms (deep-dive decision 06 §B5, §L3,
 * §L7; batch 15 plan, lane 15C items 2, 9). A refused write reaches a form
 * as an AC01 failure (lib/action-result.ts): a CommonCode and, with
 * "invalid", `fields` (key → code) from the cms's details.keys/codes or
 * from the action's own checks. Here the fields are sorted into what the
 * form shows:
 *   - an attribute key the form renders: the text under that field;
 *   - FORM_KEY (`_form`, e.g. neverPublished): a text about the whole item;
 *   - STATUS_KEY (`status`) or a key the form does not render (a refused
 *     moderator-only key, a cms the web is out of date with): a generic
 *     "reload and try again" text, since nothing on the page can be fixed.
 *
 * Texts: `manage.common.errors.<code>` for every code, and an optional
 * field-specific `manage.<area>.fields.<field>.<code>`. Every code of the
 * cms list (@sinnlos/domain AUTHORING_CODES, contract K7) plus the web's
 * own WEB_FIELD_CODES has a text in en and de: infra/contracts.test.ts.
 * No Strapi message text ever reaches the UI (AC02).
 *
 * The upload codes (batch 16, contract K14): POST /api/upload refuses a
 * file with `details.keys: ["file"]` and `fileType` or `fileTooLarge`
 * (@sinnlos/domain uploads.ts); a body above 50 MB answers 413 before the
 * cms reads it, which the upload helper maps to `fileTooLarge`.
 */
import { AUTHORING_CODES, FORM_KEY, STATUS_KEY, type AuthoringCode } from "@sinnlos/domain";

/**
 * Codes the web's own checks add (no cms code): a typed wall time that a
 * clock change repeats or skips (reject mode, plain-date.ts WallTimeError),
 * and targeting that would make an item that needs re-targeting reach
 * everyone without the author's confirmation (payload.ts).
 */
export const WEB_FIELD_CODES = ["timeRepeated", "timeSkipped", "confirmAudience"] as const;

export type WebFieldCode = (typeof WEB_FIELD_CODES)[number];

/** Every code with a text under manage.common.errors. */
export type ManageErrorCode = AuthoringCode | WebFieldCode;

export const MANAGE_ERROR_CODES: readonly ManageErrorCode[] = [
  ...AUTHORING_CODES,
  ...WEB_FIELD_CODES,
];

export function isManageErrorCode(value: unknown): value is ManageErrorCode {
  return (MANAGE_ERROR_CODES as readonly unknown[]).includes(value);
}

/** A code the web knows, else "invalid" (a newer cms code still reads sensibly). */
export function knownCode(code: string): ManageErrorCode {
  return isManageErrorCode(code) ? code : "invalid";
}

/** What a form shows of a failure's `fields`. */
export interface SortedFieldErrors {
  /** Rendered attribute → code. */
  fields: Record<string, ManageErrorCode>;
  /** The `_form` code (neverPublished, …), or null. */
  form: ManageErrorCode | null;
  /** A key the form cannot show (status, a refused or unknown key): a web or version bug. */
  unshown: boolean;
}

/**
 * Sorts `fields` (key → code) by what the form renders (`shown`: the
 * attribute keys it has an input for). Codes outside the known list read
 * as "invalid".
 */
export function sortFieldErrors(
  fields: Readonly<Record<string, string>> | undefined,
  shown: ReadonlySet<string>,
): SortedFieldErrors {
  const sorted: SortedFieldErrors = { fields: {}, form: null, unshown: false };
  for (const [key, code] of Object.entries(fields ?? {})) {
    if (key === FORM_KEY) sorted.form = knownCode(code);
    else if (key !== STATUS_KEY && shown.has(key)) sorted.fields[key] = knownCode(code);
    else sorted.unshown = true;
  }
  return sorted;
}

/** The DOM id of a field's error text, for aria-describedby and focus. */
export function fieldErrorId(formId: string, field: string): string {
  return `${formId}-${field}-error`;
}

/** The DOM id of a field's input (the first input of a date and time pair). */
export function fieldInputId(formId: string, field: string): string {
  return `${formId}-${field}`;
}
