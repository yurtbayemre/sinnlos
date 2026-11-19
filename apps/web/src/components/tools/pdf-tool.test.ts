import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import { PdfTool } from "./pdf-tool";

/**
 * The PDF tool before the client has checked the document (useCleanDocument is false in
 * a server render): the mode, the file input, the fields and the run button are locked,
 * the privacy and limits text and both live regions are there, and the English and German
 * texts carry the same promise and the same limits.
 */
function render(locale: "en" | "de") {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- a .test.ts has no JSX, and createElement's types want the provider's required children in the props
    createElement(NextIntlClientProvider, {
      locale,
      messages: locale === "en" ? en : de,
      timeZone: "Europe/Berlin",
      children: createElement(PdfTool),
    }),
  );
}

describe("the PDF tool before the document check", () => {
  const html = render("en");

  it("locks the file input and the modes, and the run button", () => {
    expect(html).toMatch(/<fieldset disabled=""[^>]*>(?:(?!<\/fieldset>)[\s\S])*type="radio"/);
    expect(html).toMatch(/<fieldset disabled=""[\s\S]*type="file"[^>]*multiple/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Create new PDF/);
  });

  it("promises only that files and entries are not transmitted, and says it does not black out", () => {
    expect(html).toContain("Your files and entries are not transmitted.");
    expect(html).toContain("does not black out anything");
    expect(html).toContain("at most 50 MB and 500 pages");
    expect(html).not.toMatch(/no network|zero|offline/i);
  });

  it("has the live regions for the list, the progress and the result, and no error yet", () => {
    expect(html.match(/role="status"/g)).toHaveLength(2);
    expect(html).not.toContain('role="alert"');
  });

  it("says the same in German", () => {
    const german = render("de");
    expect(german).toContain("Ihre Dateien und Eingaben werden nicht übertragen.");
    expect(german).toContain("höchstens 50 MB und 500 Seiten");
    expect(german).toContain("schwärzt nichts");
  });
});
