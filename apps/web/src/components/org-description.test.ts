import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrgDescription } from "./org-description";
const render = (value: string | null) =>
  renderToStaticMarkup(createElement(OrgDescription, { value, empty: "No description" }));
describe("organisation descriptions", () => {
  it("renders Markdown and plain text with the existing safe renderer", () => {
    expect(render("**Strong** and [docs](/wiki)")).toContain("<strong>Strong</strong>");
    expect(render("plain < text & more")).toContain("plain &lt; text &amp; more");
    expect(render(null)).toContain("No description");
  });
  it("keeps legacy HTML escaped plain text and never mounts hostile markup", () => {
    const html = render(
      '<p>Old <b>bold</b></p><img src=x onerror="alert(1)"><script>alert(2)</script>',
    );
    expect(html).toContain("Old bold");
    expect(html).not.toMatch(/<script|<img|<b>|onerror=/);
    expect(render("<p>&lt;script&gt;hi&lt;/script&gt;</p>")).toContain("&amp;lt;script&amp;gt;");
  });
  it("does not turn unsafe Markdown URL schemes into links", () => {
    const html = render("[bad](javascript:alert%281%29)");
    expect(html).not.toContain("href=");
    expect(html).toContain("bad");
  });
});
