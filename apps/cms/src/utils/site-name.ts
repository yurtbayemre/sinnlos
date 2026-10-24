import { parseSiteName, SITE_NAME_MAX_LENGTH } from "@sinnlos/domain";

/** An invalid SITE_NAME is reported once per process. */
let invalidReported = false;

/**
 * SITE_NAME (v0.29, S1) for the digest and account-mail subjects and the
 * TOTP issuer; null keeps the product's wording. The web reads the same
 * value with the same rule (@sinnlos/domain parseSiteName).
 */
export function siteName(env: Record<string, string | undefined> = process.env): string | null {
  const { name, invalid } = parseSiteName(env.SITE_NAME);
  if (invalid && !invalidReported) {
    invalidReported = true;
    console.warn(
      `[branding] SITE_NAME must be 1-${SITE_NAME_MAX_LENGTH} characters without control characters; it is not used`,
    );
  }
  return name;
}
