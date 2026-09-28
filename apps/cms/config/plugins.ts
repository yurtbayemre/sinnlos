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
 */
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

export default ({ env }: { env: Env }) => ({
  "users-permissions": {
    config: {
      jwt: {
        expiresIn: "7d",
      },
      jwtSecret: env("JWT_SECRET"),
      register: {
        allowedFields: ["displayName"],
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
