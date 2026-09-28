import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import AppError from "./error";

/**
 * UI04: the (app) error card is announced (role=alert), its heading can
 * take focus (the effect focuses it after mount; server markup shows the
 * target), and the error digest is shown as the reference that matches the
 * server log, in both languages. retry() stays the button's action.
 */
const render = (digest: string | undefined, locale: "en" | "de" = "en") => {
  const error = Object.assign(new Error("boom"), digest ? { digest } : {});
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- a .test.ts has no JSX, and createElement's types want the provider's required children in the props
    createElement(NextIntlClientProvider, {
      locale,
      messages: locale === "en" ? en : de,
      timeZone: "Europe/Berlin",
      children: createElement(AppError, { error, retry: () => {} }),
    }),
  );
};

describe("(app)/error.tsx (UI04)", () => {
  it("is an alert with a focusable heading", () => {
    const html = render(undefined);
    // The outermost element, the card, carries the role.
    expect(html).toMatch(/^<div [^>]*role="alert"[^>]*>/);
    expect(html).toContain(
      `<h2 tabindex="-1" class="font-medium outline-none">${en.errors.somethingWrong}</h2>`,
    );
  });

  it("shows the digest as the reference, and nothing without one", () => {
    expect(render("4242")).toContain(en.errors.reference.replace("{digest}", "4242"));
    expect(render("4242", "de")).toContain(de.errors.reference.replace("{digest}", "4242"));
    expect(render(undefined)).not.toContain(en.errors.reference.replace(" {digest}", ""));
  });

  it("keeps the retry button", () => {
    expect(render(undefined)).toContain(en.errors.tryAgain);
  });
});
