/**
 * The instance's name (v0.29, S1): `SITE_NAME`, read the same way by the web
 * (page title, sidebar, sign-in) and the cms (digest and account-mail
 * subjects, the TOTP issuer). Unset keeps the product's own wording; the
 * footer's "sinnlos {version}" is the software credit and never changes.
 */
export const SITE_NAME_MAX_LENGTH = 40;

// C0/C1 controls and the Unicode line and paragraph separators (U+2028,
// U+2029): the name lands in mail subjects and an otpauth label, so it must
// stay one line.
function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

/**
 * The trimmed `SITE_NAME`: `name` null when unset or blank; `invalid` when it
 * is longer than SITE_NAME_MAX_LENGTH characters, holds a control character
 * or the page-title placeholder "%s" (Next substitutes every "%s" of the
 * title template, the name's too); the caller warns and keeps the default.
 */
export function parseSiteName(value: string | undefined): {
  name: string | null;
  invalid: boolean;
} {
  const name = value?.trim() ?? "";
  if (!name) return { name: null, invalid: false };
  if ([...name].length > SITE_NAME_MAX_LENGTH || hasControl(name) || name.includes("%s")) {
    return { name: null, invalid: true };
  }
  return { name, invalid: false };
}
