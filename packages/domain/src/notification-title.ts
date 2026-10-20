/**
 * Notification titles in the reader's language (roadmap AC04, owner answer of
 * 2026-10-19). A notification row stores its values (`titleParams`: the
 * actor's name, the subject's title); the bell and the digest render them
 * with these templates in the reader's locale. The cms also stores the English
 * title (`title`, cut to varchar(255)) from the same English template, for
 * rows written before AC04 and as the fallback.
 */

/** notification.type (schema enum). */
export type NotificationTitleType =
  "announcement" | "comment" | "event" | "kudos" | "trainingDue" | "trainingExpired";

/** The values a title template names. */
export interface NotificationTitleParams {
  actor?: string;
  subject?: string;
}

/** Fixed text, or a value with the text that stands in for it when it is blank. */
export type NotificationTitlePart =
  string | { param: keyof NotificationTitleParams; fallback: string };

export const NOTIFICATION_TITLES: Readonly<
  Record<"en" | "de", Readonly<Record<NotificationTitleType, readonly NotificationTitlePart[]>>>
> = {
  en: {
    announcement: ["New announcement: ", { param: "subject", fallback: "Untitled" }],
    event: ["New event: ", { param: "subject", fallback: "Untitled" }],
    kudos: [{ param: "actor", fallback: "Someone" }, " gave you kudos!"],
    comment: [
      { param: "actor", fallback: "Someone" },
      ' commented on "',
      { param: "subject", fallback: "an announcement" },
      '"',
    ],
    trainingDue: ['Training "', { param: "subject", fallback: "a course" }, '" is due soon'],
    trainingExpired: [
      'Training "',
      { param: "subject", fallback: "a course" },
      '" has expired, please repeat it',
    ],
  },
  de: {
    announcement: ["Neuigkeit: ", { param: "subject", fallback: "Ohne Titel" }],
    event: ["Neuer Termin: ", { param: "subject", fallback: "Ohne Titel" }],
    kudos: [{ param: "actor", fallback: "Jemand" }, " hat Ihnen Kudos gegeben!"],
    comment: [
      { param: "actor", fallback: "Jemand" },
      " hat „",
      { param: "subject", fallback: "eine Neuigkeit" },
      "“ kommentiert",
    ],
    trainingDue: ["Unterweisung „", { param: "subject", fallback: "ein Kurs" }, "“ läuft bald ab"],
    trainingExpired: [
      "Unterweisung „",
      { param: "subject", fallback: "ein Kurs" },
      "“ ist abgelaufen, bitte wiederholen",
    ],
  },
};

/**
 * The title of a notification in `locale` (German for "de", English for
 * anything else), or null when the row has no stored values (written before
 * AC04) or an unknown type: the caller then shows the stored `title`.
 */
export function notificationTitle(type: unknown, params: unknown, locale: string): string | null {
  const templates = NOTIFICATION_TITLES[locale === "de" ? "de" : "en"];
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(templates, type)) {
    return null;
  }
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const values = params as Record<string, unknown>;
  return templates[type as NotificationTitleType]
    .map((part) => {
      if (typeof part === "string") return part;
      const value = values[part.param];
      return typeof value === "string" && value.trim() !== "" ? value.trim() : part.fallback;
    })
    .join("");
}
