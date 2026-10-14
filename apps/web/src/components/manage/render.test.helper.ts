import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import announcementsDe from "../../../messages/manage/announcements.de.json";
import announcementsEn from "../../../messages/manage/announcements.en.json";
import commonDe from "../../../messages/manage/common.de.json";
import commonEn from "../../../messages/manage/common.en.json";
import documentsDe from "../../../messages/manage/documents.de.json";
import documentsEn from "../../../messages/manage/documents.en.json";
import eventsDe from "../../../messages/manage/events.de.json";
import eventsEn from "../../../messages/manage/events.en.json";
import pollsDe from "../../../messages/manage/polls.de.json";
import pollsEn from "../../../messages/manage/polls.en.json";
import quickLinksDe from "../../../messages/manage/quickLinks.de.json";
import quickLinksEn from "../../../messages/manage/quickLinks.en.json";
import wikiDe from "../../../messages/manage/wiki.de.json";
import wikiEn from "../../../messages/manage/wiki.en.json";
import { withManageMessages } from "@/i18n/messages";

/**
 * Server-side rendering of /manage components with the real catalogs,
 * merged like i18n/messages.ts does (manage.<area>), in APP_TIME_ZONE's
 * default zone. The Radix dialogs portal on the client only, so an open
 * dialog is not part of this markup (confirm-dialog.test.ts).
 */
export const MESSAGES = {
  en: withManageMessages(en, {
    common: commonEn,
    announcements: announcementsEn,
    events: eventsEn,
    polls: pollsEn,
    quickLinks: quickLinksEn,
    documents: documentsEn,
    wiki: wikiEn,
  }),
  de: withManageMessages(de, {
    common: commonDe,
    announcements: announcementsDe,
    events: eventsDe,
    polls: pollsDe,
    quickLinks: quickLinksDe,
    documents: documentsDe,
    wiki: wikiDe,
  }),
};

export function render(element: ReactElement, locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- a .test.ts has no JSX, and createElement's types want the provider's required children in the props
    createElement(NextIntlClientProvider, {
      locale,
      messages: MESSAGES[locale],
      timeZone: "Europe/Berlin",
      children: element,
    }),
  );
}

/** The opening tag of the element with `id`. */
export function tagById(html: string, id: string): string {
  return html.match(new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`))?.[0] ?? "";
}

export const isDisabled = (tag: string) => /\sdisabled=""/.test(tag);
export const isChecked = (tag: string) => /\schecked=""/.test(tag);
