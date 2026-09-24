/**
 * Placeholder-secret boot guard (roadmap FX13).
 *
 * The env templates ship recognisable placeholders (`change-me…` in
 * infra/.env.example until FX13, `toBeModified…` in apps/cms/.env.example,
 * `<secret>` / `<openssl rand …>` in docs/DEPLOYMENT.md). Strapi accepts any
 * non-empty string, so a copied template made Strapi JWTs, admin sessions,
 * API tokens and the internal webhook / upload secrets forgeable with a
 * publicly known value. Compose `${VAR:?}` only catches EMPTY values; this
 * guard catches the placeholders:
 *   - production (NODE_ENV=production): refuse to boot (throws from
 *     register(), before any route is served);
 *   - anywhere else: one warning line, so local dev with the cms
 *     .env.example keeps working.
 * DATABASE_PASSWORD is warn-only even in production: rotating the password
 * of an existing Postgres volume needs an ALTER ROLE, not just an env edit,
 * and the db has no published port.
 *
 * Pure (env in, verdict out) — see env-guard.test.ts.
 */

/** Secrets the cms process reads whose value must be unguessable. */
export const GUARDED_SECRET_KEYS = [
  "APP_KEYS",
  "API_TOKEN_SALT",
  "ADMIN_JWT_SECRET",
  "TRANSFER_TOKEN_SALT",
  "JWT_SECRET",
  "ENCRYPTION_KEY",
  "REVALIDATE_SECRET",
  "INTERNAL_UPLOAD_TOKEN",
] as const;

/** Placeholder-checked, but never fatal (see header). */
export const WARN_ONLY_SECRET_KEYS = ["DATABASE_PASSWORD"] as const;

/** Lowercased fragments of the values the templates ship. */
const PLACEHOLDER_MARKERS = [
  "change-me",
  "changeme",
  "tobemodified",
  "generate-with-openssl",
  "placeholder",
];

/**
 * True for a template placeholder: a known marker anywhere in the value, or a
 * doc-style `<…>` stand-in. Comma-separated lists (APP_KEYS) are checked per
 * entry. Empty/unset is NOT a placeholder — presence is compose's job.
 */
export function isPlaceholderSecret(value: string | undefined): boolean {
  if (!value) return false;
  return value.split(",").some((part) => {
    const v = part.trim().toLowerCase();
    if (!v) return false;
    if (v.startsWith("<") && v.endsWith(">")) return true;
    return PLACEHOLDER_MARKERS.some((marker) => v.includes(marker));
  });
}

export interface SecretGuardVerdict {
  /** Guarded keys holding a placeholder. */
  placeholders: string[];
  /** Warn-only keys holding a placeholder. */
  warnOnly: string[];
}

export function findPlaceholderSecrets(
  env: Record<string, string | undefined>,
): SecretGuardVerdict {
  return {
    placeholders: GUARDED_SECRET_KEYS.filter((key) => isPlaceholderSecret(env[key])),
    warnOnly: WARN_ONLY_SECRET_KEYS.filter((key) => isPlaceholderSecret(env[key])),
  };
}

interface GuardLogger {
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Throws in production when a guarded secret is a placeholder; otherwise logs.
 * Never prints the values, only the key names.
 */
export function enforceSecretGuard(
  env: Record<string, string | undefined>,
  log: GuardLogger,
): void {
  const { placeholders, warnOnly } = findPlaceholderSecrets(env);
  const production = env.NODE_ENV === "production";

  if (warnOnly.length > 0) {
    log.warn(
      `[env-guard] ${warnOnly.join(", ")} still holds a template placeholder — ` +
        "rotate it (Postgres: ALTER ROLE … PASSWORD, then update the env).",
    );
  }
  if (placeholders.length === 0) return;

  const message =
    `[env-guard] placeholder value in ${placeholders.join(", ")} — ` +
    "generate real secrets (openssl rand -base64 32; APP_KEYS takes two comma-separated values).";
  if (production) {
    log.error(`${message} Refusing to start in production (FX13).`);
    throw new Error(`${message} Refusing to start in production (FX13).`);
  }
  log.warn(`${message} Tolerated outside production only.`);
}
