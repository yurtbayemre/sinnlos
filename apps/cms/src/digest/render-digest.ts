/**
 * Digest e-mail rendering (issue #18) — pure and unit tested. Plain text
 * first (the HTML is a thin wrapper): intranet notification mail, not a
 * marketing template.
 *
 * Language: the user's profile `locale` (en/de; the web's language switch
 * stores it since AC04). A user without one, or with a value that is no
 * digest language, gets DIGEST_DEFAULT_LOCALE (en or de; unset or invalid =
 * en, the owner's default of 2026-09-29, like the web's DEFAULT_LOCALE).
 */

export interface DigestContent {
  announcements: { title: string; author?: string | null }[];
  /**
   * Announcements beyond the shown ones (send-digests caps the section at
   * 25, FX48); rendered as "+N more" and counted in the subject.
   */
  announcementsMore?: number;
  mentions: { title: string }[];
  kudos: { message: string; from?: string | null; value?: string | null }[];
}

export interface RenderedDigest {
  subject: string;
  text: string;
  html: string;
}

/** The languages a digest is written in. */
export const DIGEST_LOCALES = ["en", "de"] as const;
export type DigestLocale = (typeof DIGEST_LOCALES)[number];

/** The digest language when neither the profile nor DIGEST_DEFAULT_LOCALE names one. */
export const DIGEST_FALLBACK_LOCALE: DigestLocale = "en";

function isDigestLocale(value: unknown): value is DigestLocale {
  return (DIGEST_LOCALES as readonly unknown[]).includes(value);
}

/** An invalid DIGEST_DEFAULT_LOCALE is reported once per process. */
let invalidDefaultReported = false;

/**
 * DIGEST_DEFAULT_LOCALE (trimmed, case-insensitive), or the fallback (en)
 * when it is unset or no digest language; an invalid value is logged once.
 */
export function digestDefaultLocale(
  env: Record<string, string | undefined> = process.env,
): DigestLocale {
  const raw = env.DIGEST_DEFAULT_LOCALE;
  const value = raw?.trim().toLowerCase();
  if (isDigestLocale(value)) return value;
  if (raw && raw.trim() !== "" && !invalidDefaultReported) {
    invalidDefaultReported = true;
    console.warn(
      `[digest] DIGEST_DEFAULT_LOCALE="${raw}" is not one of ${DIGEST_LOCALES.join(", ")} — using "${DIGEST_FALLBACK_LOCALE}".`,
    );
  }
  return DIGEST_FALLBACK_LOCALE;
}

/** The profile's locale when it is a digest language, else `fallback`. */
export function digestLocale(profileLocale: unknown, fallback: DigestLocale): DigestLocale {
  return isDigestLocale(profileLocale) ? profileLocale : fallback;
}

const STR = {
  de: {
    subject: (n: number) => `Sinnlos-Intranet: ${n} Neuigkeit${n === 1 ? "" : "en"} für dich`,
    greeting: (name: string) => `Hallo ${name},`,
    intro: "hier ist deine Zusammenfassung aus dem Intranet:",
    announcements: "Neuigkeiten",
    more: (n: number) => `+${n} weitere`,
    mentions: "Erwähnungen & Antworten",
    kudos: "Kudos für dich",
    kudosFrom: (from: string) => `von ${from}`,
    footer: (base: string) =>
      `Du erhältst diese Mail, weil du Digests aktiviert hast. Abbestellen: ${base}/profile`,
  },
  en: {
    subject: (n: number) => `Sinnlos intranet: ${n} update${n === 1 ? "" : "s"} for you`,
    greeting: (name: string) => `Hi ${name},`,
    intro: "here is your intranet summary:",
    announcements: "Announcements",
    more: (n: number) => `+${n} more`,
    mentions: "Mentions & replies",
    kudos: "Kudos for you",
    kudosFrom: (from: string) => `from ${from}`,
    footer: (base: string) =>
      `You receive this mail because digests are enabled in your profile. Unsubscribe: ${base}/profile`,
  },
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The "+N more" count: a positive integer, anything else is 0. */
function moreAnnouncements(content: DigestContent): number {
  const more = content.announcementsMore ?? 0;
  return Number.isInteger(more) && more > 0 ? more : 0;
}

export function totalItems(content: DigestContent): number {
  return (
    content.announcements.length +
    moreAnnouncements(content) +
    content.mentions.length +
    content.kudos.length
  );
}

export function renderDigest(
  content: DigestContent,
  opts: {
    displayName: string;
    /** The user's profile locale; missing or invalid → `defaultLocale`. */
    locale?: string | null;
    baseUrl: string;
    /** Defaults to DIGEST_DEFAULT_LOCALE (digestDefaultLocale()). */
    defaultLocale?: DigestLocale;
  },
): RenderedDigest {
  const t = STR[digestLocale(opts.locale, opts.defaultLocale ?? digestDefaultLocale())];
  const n = totalItems(content);

  const sections: { heading: string; lines: string[] }[] = [];
  if (content.announcements.length > 0) {
    const more = moreAnnouncements(content);
    sections.push({
      heading: t.announcements,
      lines: [
        ...content.announcements.map((a) => `• ${a.title}${a.author ? ` — ${a.author}` : ""}`),
        ...(more > 0 ? [`• ${t.more(more)}`] : []),
      ],
    });
  }
  if (content.mentions.length > 0) {
    sections.push({ heading: t.mentions, lines: content.mentions.map((m) => `• ${m.title}`) });
  }
  if (content.kudos.length > 0) {
    sections.push({
      heading: t.kudos,
      lines: content.kudos.map((k) => `• "${k.message}"${k.from ? ` ${t.kudosFrom(k.from)}` : ""}`),
    });
  }

  const textBody = sections
    .map((s) => `${s.heading}\n${"-".repeat(s.heading.length)}\n${s.lines.join("\n")}`)
    .join("\n\n");
  const text = [
    t.greeting(opts.displayName),
    "",
    t.intro,
    "",
    textBody,
    "",
    `${opts.baseUrl}/`,
    "",
    t.footer(opts.baseUrl),
  ].join("\n");

  const htmlSections = sections
    .map(
      (s) =>
        `<h3 style="margin:16px 0 4px">${escapeHtml(s.heading)}</h3><ul style="margin:4px 0;padding-left:18px">${s.lines
          .map((l) => `<li>${escapeHtml(l.replace(/^• /, ""))}</li>`)
          .join("")}</ul>`,
    )
    .join("");
  const html =
    `<div style="font-family:sans-serif;max-width:560px">` +
    `<p>${escapeHtml(t.greeting(opts.displayName))}</p><p>${escapeHtml(t.intro)}</p>` +
    htmlSections +
    `<p style="margin-top:16px"><a href="${escapeHtml(opts.baseUrl)}/">${escapeHtml(opts.baseUrl)}</a></p>` +
    `<p style="color:#888;font-size:12px">${escapeHtml(t.footer(opts.baseUrl))}</p></div>`;

  return { subject: t.subject(n), text, html };
}
