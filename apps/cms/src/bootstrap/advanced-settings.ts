/**
 * Sync the users-permissions "advanced" settings from env so standalone
 * (no-Microsoft) deployments work out of the box:
 *   - default_role: new local registrations land on `member` (a real
 *     intranet role) instead of the bare `authenticated` fallback.
 *   - allow_register: controlled by LOCAL_REGISTRATION=1 (default off —
 *     admins create accounts in the Strapi panel). It only gates local
 *     self-registration: Entra users are provisioned by the exchange
 *     (src/entra/provision.ts) regardless of it (FX14), and Strapi's own
 *     OAuth providers, which it would gate too, stay disabled
 *     (bootstrap/auth-providers.ts).
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
  env: Record<string, string | undefined> = process.env,
): AdvancedSettings {
  return {
    ...(current ?? {}),
    unique_email: true,
    allow_register: env.LOCAL_REGISTRATION === "1",
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

export async function syncAdvancedSettings(strapi: AdvancedSettingsHost): Promise<void> {
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
