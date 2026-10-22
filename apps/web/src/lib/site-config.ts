import pkg from "../../package.json";

/**
 * Operator configuration of the site chrome (v0.26): the release identity,
 * the source and legal links of the footer and the optional analytics
 * script. Every value is read from the runtime env (compose passes it), never
 * baked in at build time, so one image fits every install.
 */

type Env = Record<string, string | undefined>;

/** The web's release, apps/web/package.json, bundled at build time. */
export const VERSION: string = pkg.version;

/** AGPL §13: an unmodified install offers this repository as its source. */
export const DEFAULT_SOURCE_URL = "https://github.com/yurtbayemre/sinnlos";

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** `env[key]` when it is an absolute URL with one of `schemes`; unset → null, invalid → null + one warning. */
function urlFromEnv(env: Env, key: string, schemes: string[]): string | null {
  const value = env[key]?.trim();
  if (!value) return null;
  try {
    if (schemes.includes(new URL(value).protocol)) return value;
  } catch {
    // reported below
  }
  warnOnce(key, `[site] ${key} is not an ${schemes.join(" or ")} URL; it is not used`);
  return null;
}

const HTTP = ["http:", "https:"];

export interface SiteLinks {
  source: string;
  privacy: string | null;
  imprint: string | null;
  whistleblowing: string | null;
}

/** The footer's links: the source offer always, the legal links when configured. */
export function siteLinks(env: Env): SiteLinks {
  return {
    source: urlFromEnv(env, "SOURCE_URL", HTTP) ?? DEFAULT_SOURCE_URL,
    privacy: urlFromEnv(env, "PRIVACY_URL", HTTP),
    imprint: urlFromEnv(env, "IMPRINT_URL", HTTP),
    whistleblowing: urlFromEnv(env, "WHISTLEBLOWING_URL", HTTP),
  };
}

/** The image's git revision, shortened; null in development (unset or "unknown"). */
export function shortRevision(env: Env): string | null {
  const value = env.SINNLOS_REVISION?.trim();
  return value && value !== "unknown" ? value.slice(0, 7) : null;
}

/** The Plausible script: only with both PLAUSIBLE_SCRIPT_URL (https) and PLAUSIBLE_DOMAIN. */
export function plausibleScript(env: Env): { src: string; domain: string } | null {
  const src = urlFromEnv(env, "PLAUSIBLE_SCRIPT_URL", ["https:"]);
  const domain = env.PLAUSIBLE_DOMAIN?.trim() || null;
  if (src && domain) return { src, domain };
  if (src || domain) {
    warnOnce("PLAUSIBLE", "[site] analytics need PLAUSIBLE_SCRIPT_URL and PLAUSIBLE_DOMAIN; off");
  }
  return null;
}
