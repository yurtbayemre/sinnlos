/**
 * Microsoft Entra ID sign-in, enablement and validation (D-ENTRA-01 spec A,
 * deep-dive decisions/01-microsoft-signin.md). Pure: env in, settings out.
 *
 * ENTRA_ENABLED is the only switch. Anything but '1' means disabled: the
 * exchange route answers 404, no JWKS or Graph request is ever made, and
 * every MS_* / ENTRA_* value is ignored (infra/.env.example used to ship
 * non-empty MS_* placeholders, so their presence must never switch anything
 * on). With ENTRA_ENABLED=1 the whole configuration is validated, and an
 * invalid one throws an EntraConfigError that names every bad variable:
 * register() (src/index.ts) lets it fail the boot, so a broken Entra config
 * never silently falls back to local sign-in on an Entra-only install.
 * Values are never echoed (secrets); the enumerations list what is allowed.
 *
 * infra/deploy.sh repeats these rules in its awk preflight, pinned against
 * parseEntraConfig by src/utils/deploy-preflight.test.ts; the web's
 * lib/auth-config.ts validates its own half (client secret, tenant, client
 * id, exchange secret).
 */
import { ROLE_PRIVILEGE_ORDER, isRoleType, type RoleType } from "../bootstrap/roles";
import { isPlaceholderSecret } from "../utils/env-guard";

export type Env = Record<string, string | undefined>;

/** A GUID in 8-4-4-4-12 hex form, either case (stored lower-cased). */
export const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ENTRA_EXCHANGE_SECRET: at least this many characters. */
export const EXCHANGE_SECRET_MIN_LENGTH = 32;

/** ENTRA_GROUP_ROLES: at most this many distinct group ids (one checkMemberGroups call). */
export const MAX_GROUP_IDS = 20;

/** ENTRA_SESSION_TTL: at most 7 days. */
export const MAX_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export const DEFAULT_SESSION_TTL = "12h";

/**
 * The fixed Entra app-role table (spec A): the `roles` claim of the signed
 * ID token, always honoured. Define these six app roles in the app
 * registration (docs/DEPLOYMENT.md, Entra tenant setup).
 */
export const APP_ROLE_TABLE: Readonly<Record<string, RoleType>> = {
  "Intranet.Admin": "admin_role",
  "Intranet.Editor": "editor",
  "Intranet.DepartmentHead": "department_head",
  "Intranet.TeamLead": "team_lead",
  "Intranet.Member": "member",
  "Intranet.Guest": "guest",
};

export const ENTRA_SYNC_MODES = ["on", "dry-run"] as const;
export type EntraSyncMode = (typeof ENTRA_SYNC_MODES)[number];

export const ENTRA_DEFAULT_ROLES = ["member", "guest", "deny"] as const;
export type EntraDefaultRole = (typeof ENTRA_DEFAULT_ROLES)[number];

/** One ENTRA_GROUP_ROLES entry: members of `groupId` get `role`. */
export interface EntraGroupRule {
  role: RoleType;
  /** Lower-cased group object id. */
  groupId: string;
}

export interface EntraConfig {
  enabled: true;
  /** Lower-cased tenant GUID; the issuer and the JWKS URL derive from it. */
  tenantId: string;
  /** Lower-cased app (client) id GUID: the ID token's audience. */
  clientId: string;
  /** Shared with the web; compared in constant time, never logged. */
  exchangeSecret: string;
  syncMode: EntraSyncMode;
  defaultRole: EntraDefaultRole;
  groupRules: readonly EntraGroupRule[];
  /** The distinct group ids of groupRules, in first-seen order (at most 20). */
  groupIds: readonly string[];
  syncDepartment: boolean;
  syncManager: boolean;
  /** As configured, e.g. "12h" (jsonwebtoken's expiresIn format). */
  sessionTtl: string;
  sessionTtlSeconds: number;
  /** AUTH_LOCAL_ENABLED=1: local sign-in stays on next to Entra (break-glass). */
  localEnabled: boolean;
  localRegistration: boolean;
}

export interface EntraDisabled {
  enabled: false;
  /** Local sign-in is always on while Entra is off. */
  localEnabled: true;
}

export type EntraSettings = EntraConfig | EntraDisabled;

export interface EntraConfigIssue {
  variable: string;
  message: string;
}

/** ENTRA_ENABLED=1 with an invalid configuration; names every bad variable. */
export class EntraConfigError extends Error {
  readonly issues: readonly EntraConfigIssue[];

  constructor(issues: readonly EntraConfigIssue[]) {
    super(
      `[entra] ENTRA_ENABLED=1, but the Entra configuration is invalid: ${issues
        .map(({ variable, message }) => `${variable} ${message}`)
        .join(
          "; ",
        )}. Fix infra/.env (docs/DEPLOYMENT.md, "Microsoft Entra ID sign-in"), or unset ENTRA_ENABLED.`,
    );
    this.name = "EntraConfigError";
    this.issues = issues;
  }
}

const trimmed = (value: string | undefined) => (value ?? "").trim();

const TTL_PATTERN = /^(\d+)([mhd])$/;
const TTL_UNIT_SECONDS = { m: 60, h: 60 * 60, d: 24 * 60 * 60 } as const;

/**
 * ENTRA_SESSION_TTL in seconds: `<n>m`, `<n>h` or `<n>d`, more than zero and
 * at most 7d. null for anything else.
 */
export function parseSessionTtl(value: string): number | null {
  const match = TTL_PATTERN.exec(value);
  if (!match) return null;
  const seconds = Number(match[1]) * TTL_UNIT_SECONDS[match[2] as keyof typeof TTL_UNIT_SECONDS];
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > MAX_SESSION_TTL_SECONDS) {
    return null;
  }
  return seconds;
}

/**
 * ENTRA_GROUP_ROLES: a comma list of `<roleType>:<groupObjectId>`. Blanks
 * around entries are ignored, and so are empty entries. One group may map to
 * several roles (the highest wins at sign-in); at most MAX_GROUP_IDS distinct
 * groups. Returns the rules or the reason they are invalid.
 */
export function parseGroupRoles(
  value: string,
): { ok: true; rules: EntraGroupRule[]; groupIds: string[] } | { ok: false; message: string } {
  const rules: EntraGroupRule[] = [];
  const groupIds: string[] = [];
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const colon = entry.indexOf(":");
    const role = colon < 0 ? entry : entry.slice(0, colon).trim();
    const groupId =
      colon < 0
        ? ""
        : entry
            .slice(colon + 1)
            .trim()
            .toLowerCase();
    if (!isRoleType(role)) {
      return {
        ok: false,
        message: `has an entry with an unknown role (allowed: ${ROLE_PRIVILEGE_ORDER.join(", ")}; format <roleType>:<groupObjectId>)`,
      };
    }
    if (!GUID_PATTERN.test(groupId)) {
      return { ok: false, message: "has an entry whose group object id is not a GUID" };
    }
    if (!rules.some((rule) => rule.role === role && rule.groupId === groupId)) {
      rules.push({ role, groupId });
    }
    if (!groupIds.includes(groupId)) groupIds.push(groupId);
  }
  if (groupIds.length > MAX_GROUP_IDS) {
    return { ok: false, message: `names more than ${MAX_GROUP_IDS} distinct groups` };
  }
  return { ok: true, rules, groupIds };
}

function oneOf<T extends string>(values: readonly T[], value: string, fallback: T): T | null {
  if (value === "") return fallback;
  return (values as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * The Entra settings for this env (spec A). Throws EntraConfigError only
 * when ENTRA_ENABLED=1 and the configuration is invalid.
 */
export function parseEntraConfig(env: Env = process.env): EntraSettings {
  if (env.ENTRA_ENABLED !== "1") return { enabled: false, localEnabled: true };

  const issues: EntraConfigIssue[] = [];
  const issue = (variable: string, message: string) => issues.push({ variable, message });

  const tenantId = trimmed(env.MS_TENANT_ID).toLowerCase();
  if (!GUID_PATTERN.test(tenantId)) {
    issue(
      "MS_TENANT_ID",
      "must be the tenant GUID (common, organizations, consumers and domain names are refused)",
    );
  }
  const clientId = trimmed(env.MS_CLIENT_ID).toLowerCase();
  if (!GUID_PATTERN.test(clientId)) issue("MS_CLIENT_ID", "must be the app (client) id GUID");

  const exchangeSecret = env.ENTRA_EXCHANGE_SECRET ?? "";
  if (exchangeSecret.trim().length < EXCHANGE_SECRET_MIN_LENGTH) {
    issue(
      "ENTRA_EXCHANGE_SECRET",
      `must have at least ${EXCHANGE_SECRET_MIN_LENGTH} characters (openssl rand -hex 32)`,
    );
  } else if (isPlaceholderSecret(exchangeSecret)) {
    issue("ENTRA_EXCHANGE_SECRET", "holds a template placeholder (openssl rand -hex 32)");
  }

  const syncMode = oneOf(ENTRA_SYNC_MODES, trimmed(env.ENTRA_SYNC_MODE), "dry-run");
  if (syncMode === null) issue("ENTRA_SYNC_MODE", `must be one of ${ENTRA_SYNC_MODES.join(", ")}`);

  const defaultRole = oneOf(ENTRA_DEFAULT_ROLES, trimmed(env.ENTRA_DEFAULT_ROLE), "member");
  if (defaultRole === null) {
    issue("ENTRA_DEFAULT_ROLE", `must be one of ${ENTRA_DEFAULT_ROLES.join(", ")}`);
  }

  const sessionTtl = trimmed(env.ENTRA_SESSION_TTL) || DEFAULT_SESSION_TTL;
  const sessionTtlSeconds = parseSessionTtl(sessionTtl);
  if (sessionTtlSeconds === null) {
    issue("ENTRA_SESSION_TTL", "must be <n>m, <n>h or <n>d, more than zero and at most 7d");
  }

  const groups = parseGroupRoles(env.ENTRA_GROUP_ROLES ?? "");
  if (groups.ok === false) issue("ENTRA_GROUP_ROLES", groups.message);

  if (issues.length > 0) throw new EntraConfigError(issues);
  return {
    enabled: true,
    tenantId,
    clientId,
    exchangeSecret,
    syncMode: syncMode as EntraSyncMode,
    defaultRole: defaultRole as EntraDefaultRole,
    groupRules: groups.ok ? groups.rules : [],
    groupIds: groups.ok ? groups.groupIds : [],
    syncDepartment: env.ENTRA_SYNC_DEPARTMENT === "1",
    syncManager: env.ENTRA_SYNC_MANAGER === "1",
    sessionTtl,
    sessionTtlSeconds: sessionTtlSeconds as number,
    localEnabled: env.AUTH_LOCAL_ENABLED === "1",
    localRegistration: env.LOCAL_REGISTRATION === "1",
  };
}

/**
 * Boot warnings for a valid, enabled configuration. LOCAL_REGISTRATION=1
 * next to Entra is allowed (nothing links accounts by e-mail, so a
 * pre-registered address only produces a 409), but worth one line: the
 * registered address is not verified, so the admin binding of the 409
 * procedure must first check whose account it is.
 */
export function entraConfigWarnings(settings: EntraSettings): string[] {
  if (!settings.enabled) return [];
  const warnings: string[] = [];
  if (settings.localRegistration) {
    warnings.push(
      "[entra] LOCAL_REGISTRATION=1 next to Entra sign-in: anyone can register a local account. " +
        "An Entra user whose e-mail was registered first gets 409 entra_account_exists; " +
        "check who registered that account before an admin binds it (docs/DEPLOYMENT.md, the 409 procedure).",
    );
  }
  return warnings;
}

/** The one `[entra]` status line of every boot (spec L). */
export function entraStatusLine(settings: EntraSettings): string {
  if (!settings.enabled) return "[entra] disabled";
  return [
    "[entra] enabled",
    `tenant=${settings.tenantId}`,
    `mode=${settings.syncMode}`,
    `default=${settings.defaultRole}`,
    `groupRules=${settings.groupRules.length}`,
    `syncDepartment=${settings.syncDepartment ? 1 : 0}`,
    `syncManager=${settings.syncManager ? 1 : 0}`,
    `ttl=${settings.sessionTtl}`,
    `local=${settings.localEnabled ? 1 : 0}`,
  ].join(" ");
}

/** `https://login.microsoftonline.com/<tenant>/v2.0`: the only accepted issuer. */
export function entraIssuer(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/v2.0`;
}

/** The tenant's signing keys. */
export function entraJwksUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;
}
