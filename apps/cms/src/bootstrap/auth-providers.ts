/**
 * The users-permissions sign-in providers (the plugin store's `grant` key),
 * converged on every boot (D-ENTRA-01 spec L, roadmap FX44):
 *   - `email` (local e-mail + password, POST /api/auth/local) is enabled
 *     exactly when local sign-in is (utils/sign-in-policy.ts):
 *     AUTH_LOCAL_ENABLED=1, or no identity provider on. An Entra-only install thereby refuses
 *     password sign-ins in the cms itself, not only in the web's UI
 *     (users-permissions controllers/auth.js callback checks the flag);
 *   - `keycloak` (v0.25.0) is always disabled too: OIDC sign-in runs only
 *     through Auth.js and POST /api/auth/oidc/exchange, and Strapi's provider
 *     would key users on their e-mail;
 *   - `microsoft` (Strapi's own OAuth provider, /api/connect/microsoft) is
 *     always disabled with its key and secret cleared: Entra sign-in runs
 *     only through Auth.js and POST /api/auth/entra/exchange, and the stock
 *     provider keys users on their e-mail and needs allow_register.
 * Only these two entries are written; every other key of the store stays.
 * The plugins.ts `providers` block this replaces was never read.
 *
 * Also here: the Entra configuration check of register() and the one
 * `[entra]` status line of bootstrap() (src/index.ts wires all three).
 */
import { entraStatusLine, parseEntraConfig, type EntraSettings } from "../entra/config";
import {
  oidcConfigWarnings,
  oidcStatusLine,
  parseOidcConfig,
  type OidcSettings,
} from "../oidc/config";
import { discover } from "../oidc/id-token";

interface BootLog {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * register(): parses the Entra configuration from the env. Throws (and so
 * refuses the boot) only when ENTRA_ENABLED=1 and it is invalid. The
 * obsolete LOCAL_REGISTRATION is warned about by bootstrap/advanced-settings.ts
 * (v0.32, #189).
 */
export function checkEntraConfig(
  env: Record<string, string | undefined> = process.env,
): EntraSettings {
  return parseEntraConfig(env);
}

/** bootstrap(): `[entra] disabled` or `[entra] enabled tenant=… mode=… …`. */
export function reportEntraStatus(log: BootLog, settings: EntraSettings): void {
  log.info(entraStatusLine(settings));
}

export type GrantConfig = Record<string, unknown>;

type ProviderGrant = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The grant store after the sync. Pure. v0.27: EVERY provider but `email`
 * is off (each stored entry keeps its other keys), not just Microsoft and
 * Keycloak: no plugin provider callback may issue a JWT around the second
 * factor of a local account.
 */
export function nextGrantConfig(
  current: GrantConfig | null | undefined,
  localEnabled: boolean,
): GrantConfig {
  const grant = isRecord(current) ? current : {};
  const email: ProviderGrant = isRecord(grant.email) ? grant.email : {};
  const microsoft: ProviderGrant = isRecord(grant.microsoft) ? grant.microsoft : {};
  const keycloak: ProviderGrant = isRecord(grant.keycloak) ? grant.keycloak : {};
  const others = Object.fromEntries(
    Object.entries(grant)
      .filter(([name, value]) => name !== "email" && isRecord(value))
      .map(([name, value]) => [name, { ...(value as ProviderGrant), enabled: false }]),
  );
  return {
    ...grant,
    ...others,
    email: { ...email, enabled: localEnabled },
    microsoft: { ...microsoft, enabled: false, key: "", secret: "" },
    keycloak: { ...keycloak, enabled: false },
  };
}

/** The slice of the Strapi instance syncAuthProviders touches. */
export interface AuthProvidersHost {
  store(key: { type: string; name: string; key: string }): {
    get(): Promise<unknown>;
    set(params: { value: GrantConfig }): Promise<unknown>;
  };
  log: { info(message: string): void };
}

export async function syncAuthProviders(
  strapi: AuthProvidersHost,
  settings: EntraSettings,
): Promise<void> {
  const store = strapi.store({ type: "plugin", name: "users-permissions", key: "grant" });
  const stored = await store.get();
  const current = isRecord(stored) ? stored : {};
  const next = nextGrantConfig(current, settings.localEnabled);
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    await store.set({ value: next });
    strapi.log.info(
      `[bootstrap] users-permissions providers synced (email=${settings.localEnabled ? "on" : "off"}, every other provider off)`,
    );
  }
}

/**
 * register(): the OIDC configuration (v0.25.0). Throws (and so refuses the
 * boot) only when OIDC_ENABLED=1 and it is invalid; logs the warnings of a
 * valid one.
 */
export function checkOidcConfig(
  log: BootLog,
  env: Record<string, string | undefined> = process.env,
): OidcSettings {
  const settings = parseOidcConfig(env);
  for (const warning of oidcConfigWarnings(settings)) log.warn(warning);
  return settings;
}

/**
 * bootstrap(): `[oidc] disabled` or `[oidc] enabled …`, and with OIDC on one
 * look at the discovery document, so a wrong OIDC_ISSUER shows right after a
 * deploy (plan-oidc.md finding 5). A document that does not fit the
 * configuration (another issuer, an http endpoint) refuses the boot like an
 * invalid env; an identity provider that cannot be reached is only logged:
 * it must not keep the cms (and local break-glass) from starting, and
 * sign-ins answer 503 until it works.
 */
export async function reportOidcStatus(
  log: BootLog & { error(message: string): void },
  settings: OidcSettings,
  discoverImpl: typeof discover = discover,
): Promise<void> {
  log.info(oidcStatusLine(settings));
  if (!settings.enabled) return;
  const found = await discoverImpl(settings);
  if (found.ok === false) {
    if (found.reason === "mismatch") {
      throw new Error(
        `[oidc] ${found.detail}. Fix OIDC_ISSUER or the identity provider (docs/SSO.md, "OIDC sign-in (Keycloak, authentik, Zitadel)"); refusing to start with OIDC_ENABLED=1.`,
      );
    }
    log.error(
      `[oidc] discovery failed: ${found.detail}. Sign-ins answer 503 until it works (docs/SSO.md, "OIDC sign-in (Keycloak, authentik, Zitadel)").`,
    );
    return;
  }
  log.info(`[oidc] discovery OK (issuer ${found.discovery.issuer})`);
}
