/**
 * Digest e-mail rendering (issue #18) — pure and unit tested. Plain text
 * first (the HTML is a thin wrapper): intranet notification mail, not a
 * marketing template. Locale follows the user's profile locale (de/en).
 */

export interface DigestContent {
  announcements: { title: string; author?: string | null }[];
  mentions: { title: string }[];
  kudos: { message: string; from?: string | null; value?: string | null }[];
}

export interface RenderedDigest {
  subject: string;
  text: string;
  html: string;
}

const STR = {
  de: {
    subject: (n: number) => `Sinnlos-Intranet: ${n} Neuigkeit${n === 1 ? "" : "en"} für dich`,
    greeting: (name: string) => `Hallo ${name},`,
    intro: "hier ist deine Zusammenfassung aus dem Intranet:",
    announcements: "Neuigkeiten",
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

export function totalItems(content: DigestContent): number {
  return content.announcements.length + content.mentions.length + content.kudos.length;
}

export function renderDigest(
  content: DigestContent,
  opts: { displayName: string; locale?: string | null; baseUrl: string },
): RenderedDigest {
  const t = STR[opts.locale === "de" ? "de" : "en"];
  const n = totalItems(content);

  const sections: { heading: string; lines: string[] }[] = [];
  if (content.announcements.length > 0) {
    sections.push({
      heading: t.announcements,
      lines: content.announcements.map(
        (a) => `• ${a.title}${a.author ? ` — ${a.author}` : ""}`,
      ),
    });
  }
  if (content.mentions.length > 0) {
    sections.push({ heading: t.mentions, lines: content.mentions.map((m) => `• ${m.title}`) });
  }
  if (content.kudos.length > 0) {
    sections.push({
      heading: t.kudos,
      lines: content.kudos.map(
        (k) => `• "${k.message}"${k.from ? ` ${t.kudosFrom(k.from)}` : ""}`,
      ),
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
