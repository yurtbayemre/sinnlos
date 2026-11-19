import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import { QrTool } from "./qr-tool";

/**
 * The QR tool before the client has checked the document (useCleanDocument is false in a
 * server render): the kinds, the fields and the button are locked, the privacy text and the
 * live regions are there, no field carries a `name` (a native submit would send none of
 * them), and the English and German texts carry the same promise.
 */
function render(locale: "en" | "de") {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- a .test.ts has no JSX, and createElement's types want the provider's required children in the props
    createElement(NextIntlClientProvider, {
      locale,
      messages: locale === "en" ? en : de,
      timeZone: "Europe/Berlin",
      children: createElement(QrTool),
    }),
  );
}

describe("the QR tool before the document check", () => {
  const html = render("en");

  it("locks the kinds, the fields and the button", () => {
    expect(html).toMatch(/<fieldset disabled=""[^>]*>(?:(?!<\/fieldset>)[\s\S])*type="radio"/);
    expect(html).toMatch(/<fieldset disabled=""[\s\S]*<textarea/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Create QR code/);
  });

  it("promises that entries are not transmitted or stored, and warns that the code is plain text", () => {
    expect(html).toContain("Your entries are not transmitted or stored.");
    expect(html).toContain("a Wi-Fi password included");
  });

  it("has a status region, no error yet, and no field with a name", () => {
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).not.toContain('role="alert"');
    for (const control of html.match(/<(?:input|textarea|select)\b[^>]*>/g) ?? []) {
      if (!/type="radio"/.test(control)) expect(control).not.toMatch(/\sname=/);
    }
  });

  it("says the same in German", () => {
    expect(render("de")).toContain("Ihre Eingaben werden nicht übertragen und nicht gespeichert.");
  });
});
