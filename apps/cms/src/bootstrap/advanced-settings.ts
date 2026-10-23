/**
 * Sync the users-permissions "advanced" settings so standalone
 * (no-Microsoft) deployments work out of the box:
 *   - default_role: `member` (a real intranet role) instead of the bare
 *     `authenticated` fallback.
 *   - allow_register: always off (v0.27: admins invite people at
 *     /manage/users; LOCAL_REGISTRATION is gone, and the boot warns when it
 *     is still 1). Entra and OIDC users are provisioned by their exchange
 *     regardless of it (FX14), and Strapi's own OAuth providers stay
 *     disabled (bootstrap/auth-providers.ts).
 *   - email_confirmation: off; self-hosted installs rarely have SMTP.
 *   - unique_email: on.
 * These four keys are OVERWRITTEN on every boot (an admin-panel change to
 * them does not survive a restart); every other key of the store is kept.
 */

import type { RoleType } from "./roles";

export type AdvancedSettings = Record<string, unknown>;

/** The role a newly registered user gets. */
const DEFAULT_ROLE: RoleType = "member";

/** The managed keys applied over the stored settings. Pure. */
export function nextAdvancedSettings(
  current: AdvancedSettings | null | undefined,
): AdvancedSettings {
  return {
    ...(current ?? {}),
    unique_email: true,
    allow_register: false,
    email_confirmation: false,
    default_role: DEFAULT_ROLE,
  };
}

/** The slice of the Strapi instance syncAdvancedSettings touches. */
export interface AdvancedSettingsHost {
  store(key: { type: string; name: string; key: string }): {
    get(): Promise<unknown>;
    set(params: { value: AdvancedSettings }): Promise<unknown>;
  };
  log: { info(message: string): void };
}

const isSettings = (value: unknown): value is AdvancedSettings =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function syncAdvancedSettings(
  strapi: AdvancedSettingsHost & { log: { warn(message: string): void } },
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (env.LOCAL_REGISTRATION === "1") {
    strapi.log.warn(
      "[bootstrap] LOCAL_REGISTRATION is set but self-registration is gone since v0.27: invite people at /manage/users; remove the variable",
    );
  }
  const store = strapi.store({ type: "plugin", name: "users-permissions", key: "advanced" });
  const stored = await store.get();
  const current = isSettings(stored) ? stored : {};
  const next = nextAdvancedSettings(current);

  if (JSON.stringify(next) !== JSON.stringify(current)) {
    await store.set({ value: next });
    strapi.log.info(
      `[bootstrap] users-permissions advanced settings synced (allow_register=${String(next.allow_register)}, default_role=${DEFAULT_ROLE})`,
    );
  }
}
