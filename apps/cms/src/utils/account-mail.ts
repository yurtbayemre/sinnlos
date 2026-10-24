/**
 * The two account mails of v0.27: an invitation and a password reset, each
 * with a set-password link. Same transport as the digest (the email
 * plugin, SMTP_* and the sender DIGEST_FROM), but its own readiness check:
 * an instance can turn the digests off and still invite people. The link
 * carries the token in the URL fragment (`/set-password#<token>`), so it
 * never reaches a server log or a Referer.
 */
import { digestLocale, digestDefaultLocale, type DigestLocale } from "../digest/render-digest";
import { errorLabel } from "../idp/exchange-core";
import { siteName } from "./site-name";

export type AccountMailKind = "invite" | "reset";

/** How long a mail may take before it counts as not sent (rev3 #10). */
export const MAIL_TIMEOUT_MS = 15_000;

/** Whether account mails can be sent; the web origin for the link when so. */
export function accountMailReady(
  env: Record<string, string | undefined> = process.env,
): { ok: true; baseUrl: string } | { ok: false; reason: string } {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    return { ok: false, reason: "SMTP env incomplete (SMTP_HOST/USER/PASS)" };
  }
  if (!(env.DIGEST_FROM ?? "").trim()) return { ok: false, reason: "DIGEST_FROM unset" };
  const baseUrl = (env.PUBLIC_WEB_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) return { ok: false, reason: "PUBLIC_WEB_URL unset" };
  return { ok: true, baseUrl };
}

const TEXT = {
  de: {
    invite: {
      subject: (site: string | null) => (site ? `Einladung zu ${site}` : "Einladung ins Intranet"),
      intro:
        "du wurdest ins Intranet eingeladen. Lege hier dein Passwort fest (der Link gilt 7 Tage):",
      outro: "Wenn du diese Einladung nicht erwartet hast, ignoriere diese Mail.",
    },
    reset: {
      subject: (site: string | null) =>
        site ? `${site}: Passwort zurücksetzen` : "Passwort zurücksetzen",
      intro:
        "für dein Konto wurde ein neues Passwort angefordert. Lege es hier fest (der Link gilt 1 Stunde):",
      outro: "Wenn du das nicht warst, ignoriere diese Mail: dein Passwort bleibt, wie es ist.",
    },
    greeting: (name: string) => (name ? `Hallo ${name},` : "Hallo,"),
  },
  en: {
    invite: {
      subject: (site: string | null) =>
        site ? `Invitation to ${site}` : "Invitation to the intranet",
      intro:
        "you have been invited to the intranet. Set your password here (the link is valid for 7 days):",
      outro: "If you did not expect this invitation, ignore this mail.",
    },
    reset: {
      subject: (site: string | null) =>
        site ? `${site}: Reset your password` : "Reset your password",
      intro:
        "a new password was requested for your account. Set it here (the link is valid for 1 hour):",
      outro: "If this was not you, ignore this mail: your password stays as it is.",
    },
    greeting: (name: string) => (name ? `Hi ${name},` : "Hi,"),
  },
} as const;

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderAccountMail(
  kind: AccountMailKind,
  locale: DigestLocale,
  link: string,
  name: string,
  site: string | null = siteName(),
): { subject: string; text: string; html: string } {
  const strings = TEXT[locale];
  const parts = strings[kind];
  const greeting = strings.greeting(name);
  return {
    subject: parts.subject(site),
    text: `${greeting}\n\n${parts.intro}\n${link}\n\n${parts.outro}\n`,
    html:
      `<p>${escapeHtml(greeting)}</p><p>${escapeHtml(parts.intro)}<br>` +
      `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>${escapeHtml(parts.outro)}</p>`,
  };
}

export interface AccountMailHost {
  plugin(name: string): { service(name: string): object };
  log: { info(message: string): void; warn(message: string): void };
}

/**
 * Sends one account mail; true when the transport took it. Never throws and
 * never logs the link or the address (the token is in the link). The answer
 * comes after MAIL_TIMEOUT_MS at the latest, but the transport goes on;
 * `untilSettled` returns only once it has settled (a caller that bounds its
 * sends keeps its slot that long).
 */
export async function sendAccountMail(
  strapi: AccountMailHost,
  mail: { to: string; kind: AccountMailKind; token: string; name: string; locale?: unknown },
  { untilSettled = false }: { untilSettled?: boolean } = {},
): Promise<boolean> {
  const ready = accountMailReady();
  if ("reason" in ready) {
    strapi.log.warn(`[account-mail] not sent: ${ready.reason}`);
    return false;
  }
  const link = `${ready.baseUrl}/set-password#${mail.token}`;
  const rendered = renderAccountMail(
    mail.kind,
    digestLocale(mail.locale, digestDefaultLocale()),
    link,
    mail.name,
  );
  let timer: NodeJS.Timeout | undefined;
  let sending: Promise<unknown> | undefined;
  try {
    const email = strapi.plugin("email").service("email") as {
      send(options: { to: string; subject: string; text: string; html: string }): Promise<unknown>;
    };
    sending = email.send({ to: mail.to, ...rendered });
    await Promise.race([
      sending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), MAIL_TIMEOUT_MS);
      }),
    ]);
    strapi.log.info(`[account-mail] ${mail.kind} sent`);
    return true;
  } catch (err) {
    strapi.log.warn(`[account-mail] ${mail.kind} not sent (${errorLabel(err)})`);
    return false;
  } finally {
    clearTimeout(timer);
    if (untilSettled) await sending?.catch(() => undefined);
  }
}
