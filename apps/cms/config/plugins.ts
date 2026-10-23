/**
 * Strapi plugin configuration.
 *
 * users-permissions: Strapi JWTs of local sign-ins last 7 days; Entra
 * sign-ins get ENTRA_SESSION_TTL (12h by default) from the exchange
 * (src/entra/provision.ts). There is no `providers` block: Strapi's own
 * Microsoft provider is not used (Entra sign-in runs through Auth.js and
 * POST /api/auth/entra/exchange, D-ENTRA-01), provider enablement lives in
 * the plugin store's grant key, and src/bootstrap/auth-providers.ts forces
 * grant.microsoft off on every boot. Self-registration (LOCAL_REGISTRATION=1)
 * accepts displayName as its only extra field: microsoftOid, jobTitle and
 * avatar are not the registrant's to set (FX14).
 *
 * `jwtManagement: "legacy-support"` is the plugin's default, pinned here:
 * the token version that lets a password change revoke older JWTs (FX40,
 * src/extensions/users-permissions/strapi-server.ts) works on these legacy
 * JWTs, and the web keeps one Strapi JWT per session (D-SESSION-01, no
 * refresh flow). "refresh" would change both; it is a decision of its own.
 */
import { assertPasswordAllowed } from "../src/extensions/users-permissions/strapi-server";

type Env = ((key: string, def?: unknown) => any) & {
  int: (key: string, def?: number) => number;
  bool: (key: string, def?: boolean) => boolean;
  array: (key: string, def?: string[]) => string[];
};

/**
 * The nodemailer transport security for SMTP_PORT (B05): port 465 is
 * implicit TLS (SMTPS, the connection is encrypted from the first byte);
 * every other port, 587 submission included, starts in plain text and must
 * upgrade with STARTTLS — requireTLS makes nodemailer refuse to send when
 * the server does not offer it.
 */
export function smtpTransportSecurity(port: number): { secure: boolean; requireTLS: boolean } {
  const implicitTls = port === 465;
  return { secure: implicitTls, requireTLS: !implicitTls };
}

/** The admin-panel macro backstop (see `upload` below). */
export const OFFICE_MACRO_DENIED_TYPES = [
  "application/vnd.ms-word.*macroenabled*",
  "application/vnd.ms-excel.*macroenabled*",
  "application/vnd.ms-powerpoint.*macroenabled*",
] as const;

export default ({ env }: { env: Env }) => ({
  "users-permissions": {
    config: {
      jwt: {
        expiresIn: "7d",
      },
      jwtManagement: "legacy-support",
      jwtSecret: env("JWT_SECRET"),
      register: {
        allowedFields: ["displayName"],
      },
      // The password baseline (v0.27) for change-password: the plugin
      // answers 400 with this message (password_<problem>).
      validationRules: {
        validatePassword(password: string): boolean {
          assertPasswordAllowed(password);
          return true;
        },
      },
    },
  },
  /**
   * Upload hardening (marketplace ads opened the content-api upload route
   * to regular employees for the first time):
   *
   *  - `sizeLimit` caps EVERY upload (admin panel included) at 50 MB —
   *    down from Strapi's 1 GB default. The strapi::body formidable limit
   *    in config/middlewares.ts is kept consistent with this value.
   *    Employee uploads via POST /api/upload are additionally capped at
   *    5 MB per image in src/extensions/upload/strapi-server.ts.
   *  - `security.deniedTypes` is the native magic-byte MIME check (Strapi
   *    >= 5.31, checks real file signatures via file-type, not extensions).
   *    It runs for admin AND content-api uploads. SVG is denied globally:
   *    it is a stored-XSS vector (script/event handlers in XML; Strapi
   *    upload XSS history: CVE-2022-32114). Executables/HTML likewise.
   *    The content-api route is further restricted to a JPEG/PNG/WebP
   *    allowlist in the upload extension; this deny list is the backstop
   *    that also covers admin-panel uploads.
   *  - The Office macro backstop (deep-dive decision 06 §E1, owner amendment
   *    2; batch 16 lane 16A): the three `*macroenabled*` patterns. Strapi
   *    matches them case-insensitively, `*` as a wildcard, against the
   *    declared type, the extension's type and file-type's guess from the
   *    first 4100 bytes (upload-validation.contract.test.ts). So the panel
   *    refuses a .docm/.dotm/.xlsm/.xltm/.xlam/.xlsb/.pptm/.potm/.ppsm by its
   *    extension, and a renamed macro file only when file-type recognises it
   *    in that window. A renamed .xlsb always passes (file-type answers
   *    application/zip for it), and so does a renamed macro file whose
   *    `[Content_Types].xml` lies beyond the window: the known limits. The
   *    content-API profile (utils/upload-ooxml.ts) does not depend on this.
   */
  upload: {
    config: {
      sizeLimit: 50 * 1024 * 1024,
      security: {
        deniedTypes: [
          "image/svg+xml",
          "text/html",
          "application/xhtml+xml",
          "text/javascript",
          "application/javascript",
          "application/x-sh",
          "application/x-dosexec",
          "application/x-msdownload",
          "application/x-executable",
          "application/x-elf",
          "application/x-mach-binary",
          "application/vnd.microsoft.portable-executable",
          ...OFFICE_MACRO_DENIED_TYPES,
        ],
      },
    },
  },
  // E-mail digests (issue #18). Authenticated submission against the own
  // mailcow on mail.yurtbay.dev:587 (STARTTLS) — deliberately NOT via the
  // mailcow-internal Docker network (that attachment is a documented
  // mailcow-update landmine). Sender identity = a mailbox app password
  // (SMTP-only) in infra/.env; without SMTP_* the digest cron no-ops.
  // Sender/reply-to come from env only (FX13, no owner-domain defaults);
  // without DIGEST_FROM the digest cron skips with a warning.
  // SMTP_PORT=465 uses implicit TLS, any other port STARTTLS
  // (smtpTransportSecurity above).
  email: {
    config: {
      provider: "nodemailer",
      providerOptions: {
        host: env("SMTP_HOST", ""),
        port: env.int("SMTP_PORT", 587),
        auth: env("SMTP_USER", "")
          ? { user: env("SMTP_USER", ""), pass: env("SMTP_PASS", "") }
          : undefined,
        ...smtpTransportSecurity(env.int("SMTP_PORT", 587)),
      },
      settings: {
        defaultFrom: env("DIGEST_FROM", "") || undefined,
        defaultReplyTo: env("DIGEST_REPLY_TO", "") || undefined,
      },
    },
  },
});
