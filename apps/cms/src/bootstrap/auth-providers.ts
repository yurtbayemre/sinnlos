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
import {
  entraConfigWarnings,
  entraStatusLine,
  parseEntraConfig,
  type EntraSettings,
} from "../entra/config";
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
 * refuses the boot) only when ENTRA_ENABLED=1 and it is invalid; logs the
 * warnings of a valid one.
 */
export function checkEntraConfig(
  log: BootLog,
  env: Record<string, string | undefined> = process.env,
): EntraSettings {
  const settings = parseEntraConfig(env);
  for (const warning of entraConfigWarnings(settings)) log.warn(warning);
  return settings;
}

/** bootstrap(): `[entra] disabled` or `[entra] enabled tenant=… mode=… …`. */
export function reportEntraStatus(log: BootLog, settings: EntraSettings): void {
  log.info(entraStatusLine(settings));
}

export type GrantConfig = Record<string, unknown>;

type ProviderGrant = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The grant store after the sync. Pure. */
export function nextGrantConfig(
  current: GrantConfig | null | undefined,
  localEnabled: boolean,
): GrantConfig {
  const grant = isRecord(current) ? current : {};
  const email: ProviderGrant = isRecord(grant.email) ? grant.email : {};
  const microsoft: ProviderGrant = isRecord(grant.microsoft) ? grant.microsoft : {};
  const keycloak: ProviderGrant = isRecord(grant.keycloak) ? grant.keycloak : {};
  return {
    ...grant,
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
      `[bootstrap] users-permissions providers synced (email=${settings.localEnabled ? "on" : "off"}, microsoft=off, keycloak=off)`,
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
 * deploy (plan-oidc.md finding 5). Logged only, never fatal: an identity
 * provider that is down must not keep the cms (and local break-glass) from
 * starting; sign-ins answer 503 until it works.
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
    log.error(
      `[oidc] discovery failed: ${found.detail}. Sign-ins answer 503 until it works (docs/DEPLOYMENT.md, "OIDC sign-in").`,
    );
    return;
  }
  log.info(`[oidc] discovery OK (issuer ${found.discovery.issuer})`);
}
