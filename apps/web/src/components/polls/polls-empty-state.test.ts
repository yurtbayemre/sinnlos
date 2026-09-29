import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import { PollsEmptyState } from "./polls-empty-state";

/**
 * The /polls empty state (owner decision 2026-09-27): polls are hidden from
 * guests unless opened to them, so a guest's list is usually empty. A guest
 * gets wording of their own instead of "No polls yet" and the admin-panel
 * hint; everyone else keeps the generic one. Rendered with the real
 * catalogs.
 */
const render = (viewerRole: string | null | undefined, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- a .test.ts has no JSX, and createElement's types want the provider's required children in the props
    createElement(NextIntlClientProvider, {
      locale,
      messages: locale === "en" ? en : de,
      timeZone: "Europe/Berlin",
      children: createElement(PollsEmptyState, { viewerRole }),
    }),
  );

describe("PollsEmptyState", () => {
  it("tells a guest that no poll is open to them yet, without the admin-panel hint", () => {
    const html = render("guest");
    expect(html).toContain(en.polls.emptyTitleGuest);
    expect(html).toContain(en.polls.emptyHintGuest);
    expect(html).not.toContain(en.polls.emptyTitle);
    expect(html).not.toContain(en.polls.emptyHint);
  });

  it("keeps the generic empty state for every other role and without a readable role", () => {
    for (const role of [
      "admin_role",
      "editor",
      "member",
      "authenticated",
      "Guest",
      "",
      null,
      undefined,
    ]) {
      const html = render(role);
      expect(html, String(role)).toContain(en.polls.emptyTitle);
      expect(html, String(role)).toContain(en.polls.emptyHint);
      expect(html, String(role)).not.toContain(en.polls.emptyTitleGuest);
    }
  });

  it("has the guest wording in German too", () => {
    const html = render("guest", "de");
    expect(html).toContain(de.polls.emptyTitleGuest);
    expect(html).toContain(de.polls.emptyHintGuest);
    expect(render("member", "de")).toContain(de.polls.emptyTitle);
  });
});
