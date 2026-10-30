import { SITE_NAME_MAX_LENGTH, parseSiteName } from "@sinnlos/domain";
import pkg from "../../package.json";
import { deriveAccentPalette, hexToHsl, type AccentTokens, type ThemeName } from "./contrast";

/**
 * Operator configuration of the site chrome (v0.26): the release identity,
 * the source and legal links of the footer, the optional analytics script
 * and (v0.29) the branding. Every value is read from the runtime env (compose passes it), never
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

/**
 * The revision a tab compares with the live stream's hello (#214): the first
 * 12 hex characters, lower-cased, because a build-mode deploy passes 12 and
 * the registry and release images the full SHA. Null without one.
 */
export function buildRevision(env: Env): string | null {
  const value = env.SINNLOS_REVISION?.trim().toLowerCase() ?? "";
  return /^[0-9a-f]{12,64}$/.test(value) ? value.slice(0, 12) : null;
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

/**
 * A logo or icon URL (v0.29, S1): an absolute https URL without credentials
 * (no root-relative, protocol-relative or backslash forms). It loads before
 * sign-in, so its host sees visitors' addresses: host it yourself.
 */
function assetUrlFromEnv(env: Env, key: string): string | null {
  const value = env[key]?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      value.toLowerCase().startsWith("https://") &&
      !value.includes("\\") &&
      !url.username &&
      !url.password
    ) {
      return value;
    }
  } catch {
    // reported below
  }
  warnOnce(
    `${key}=${value}`,
    `[branding] ${key} must be an https URL without credentials; it is not used`,
  );
  return null;
}

export interface Brand {
  /** SITE_NAME, or null for the product's own wording. */
  name: string | null;
  logoUrl: string | null;
  iconUrl: string | null;
  /** The SITE_ACCENT tokens of both themes, or null for the stylesheet's own. */
  palette: Record<ThemeName, AccentTokens> | null;
}

/** The product's wording when SITE_NAME is unset. */
export const DEFAULT_SITE_NAME = "Sinnlos";

/** The instance's branding (v0.29, S1): every key optional, invalid ones warn once and fall back. */
export function brand(env: Env): Brand {
  const site = parseSiteName(env.SITE_NAME);
  if (site.invalid) {
    warnOnce(
      `SITE_NAME=${env.SITE_NAME}`,
      `[branding] SITE_NAME must be 1-${SITE_NAME_MAX_LENGTH} characters without control characters or "%s"; it is not used`,
    );
  }
  const accent = env.SITE_ACCENT?.trim();
  const palette = accent ? deriveAccentPalette(accent) : null;
  if (accent && !palette) {
    warnOnce(
      `SITE_ACCENT=${accent}`,
      hexToHsl(accent)
        ? `[branding] SITE_ACCENT ${accent} fails the contrast checks; the default colours are used`
        : "[branding] SITE_ACCENT must be #rrggbb; the default colours are used",
    );
  }
  return {
    name: site.name,
    logoUrl: assetUrlFromEnv(env, "SITE_LOGO_URL"),
    iconUrl: assetUrlFromEnv(env, "SITE_ICON_URL"),
    palette,
  };
}
