import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { rehypeWikiToc } from "@/lib/wiki-content";
import { Markdown, markdownLinkKind } from "./markdown";

/**
 * The shared Markdown renderer (UI03), server-rendered with react-dom as
 * the wiki, lesson and announcement pages render it. The safety rules:
 * raw HTML never becomes markup (no rehype-raw), unsafe URL schemes are
 * dropped by react-markdown's default urlTransform (the link keeps only
 * its text, the image only its alt), external links open in a new tab
 * without an opener or a referrer, images load lazily. Plus the pieces
 * the pages rely on: in-app links through next/link, fragment links as
 * plain anchors, and the wiki's heading anchors and table of contents.
 */

const render = (markdown: string, props: Parameters<typeof Markdown>[0] = {}) =>
  renderToStaticMarkup(createElement(Markdown, props, markdown));

interface Tag {
  name: string;
  attrs: Record<string, string>;
}

/**
 * Every start tag of `html` with its attributes. React escapes `"` in
 * attribute values, so a value never contains a raw quote and the split
 * below is exact: text that merely LOOKS like an attribute inside a value
 * (title="x&quot; onerror=…") never shows up as an attribute name.
 */
function tags(html: string): Tag[] {
  const found: Tag[] = [];
  for (const [, name, rest] of html.matchAll(/<([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const attrs: Record<string, string> = {};
    for (const [, key, value] of rest.matchAll(/([^\s=/"]+)(?:="([^"]*)")?/g)) {
      attrs[key.toLowerCase()] = value ?? "";
    }
    found.push({ name: name.toLowerCase(), attrs });
  }
  return found;
}

const elementsNamed = (html: string, name: string) => tags(html).filter((t) => t.name === name);

/** No element carries an event handler attribute (on…). */
function expectNoHandlers(html: string) {
  for (const tag of tags(html)) {
    expect(Object.keys(tag.attrs).filter((key) => key.startsWith("on"))).toEqual([]);
  }
}

/** No href, src or other URL attribute uses a scheme outside the safe list. */
function expectOnlySafeUrls(html: string) {
  for (const tag of tags(html)) {
    for (const key of ["href", "src", "srcset", "action", "formaction", "xlink:href"]) {
      const value = tag.attrs[key];
      if (value === undefined) continue;
      expect(value.toLowerCase()).not.toMatch(/^\s*(javascript|vbscript|data|file):/);
    }
  }
}

describe("Markdown: raw HTML is never markup", () => {
  it("shows a script tag as text", () => {
    const html = render('Hi <script>alert("x")</script> there');
    expect(elementsNamed(html, "script")).toEqual([]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Hi ");
  });

  it("shows an HTML block with an event handler as text", () => {
    const html = render('<img src="x" onerror="alert(1)">\n\n<div onclick="alert(2)">x</div>');
    expect(elementsNamed(html, "img")).toEqual([]);
    expect(elementsNamed(html, "div")).toHaveLength(1); // the wrapper only
    expectNoHandlers(html);
  });

  it("shows inline HTML links, iframes and styles as text", () => {
    const html = render(
      'a <a href="javascript:alert(1)">x</a> <iframe src="https://evil.example"></iframe> <style>*{}</style>',
    );
    expect(elementsNamed(html, "a")).toEqual([]);
    expect(elementsNamed(html, "iframe")).toEqual([]);
    expect(elementsNamed(html, "style")).toEqual([]);
  });

  it("keeps a Markdown title that imitates an attribute inside the attribute", () => {
    const html = render('![pic](https://example.com/a.png "t\\" onerror=\\"alert(1)")');
    const [img] = elementsNamed(html, "img");
    expect(img.attrs.title).toBe("t&quot; onerror=&quot;alert(1)");
    expectNoHandlers(html);
  });
});

describe("Markdown: unsafe URLs are neutralised", () => {
  it.each([
    ["javascript:", "[click](javascript:alert(1))"],
    ["an upper-case JavaScript:", "[click](JaVaScRiPt:alert(1))"],
    ["an entity-encoded javascript:", "[click](&#106;avascript:alert(1))"],
    ["vbscript:", "[click](vbscript:msgbox(1))"],
    ["data:", "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)"],
    ["file:", "[click](file:///etc/passwd)"],
    ["a javascript: autolink", "<javascript:alert(1)>"],
    ["a javascript: reference link", "[click][x]\n\n[x]: javascript:alert(1)"],
  ])("renders a %s link as plain text", (_label, markdown) => {
    const html = render(markdown);
    expect(elementsNamed(html, "a")).toEqual([]);
    expectOnlySafeUrls(html);
    expect(html).toMatch(/<span>[^<]+<\/span>/);
  });

  it.each([
    ["data:", "![a tracking pixel](data:image/png;base64,iVBORw0KGgo=)"],
    ["javascript:", "![a script](javascript:alert(1))"],
  ])("renders a %s image as its alt text", (_label, markdown) => {
    const html = render(markdown);
    expect(elementsNamed(html, "img")).toEqual([]);
    expect(html).toMatch(/<span>a (tracking pixel|script)<\/span>/);
  });

  it("renders a neutralised image without alt text as nothing", () => {
    expect(render("![](data:image/png;base64,iVBORw0KGgo=)")).toBe(
      '<div class="prose prose-slate max-w-none dark:prose-invert"><p></p></div>',
    );
  });
});

describe("Markdown: links", () => {
  it("renders an in-app path as a same-tab link (next/link)", () => {
    const [a] = elementsNamed(render("[Handbook](/wiki/eng/handbook)"), "a");
    expect(a.attrs.href).toBe("/wiki/eng/handbook");
    expect(a.attrs.target).toBeUndefined();
    expect(a.attrs.rel).toBeUndefined();
  });

  it.each([
    ["an https URL", "[site](https://example.com/x)", "https://example.com/x"],
    ["an http URL", "[site](http://example.com)", "http://example.com"],
    ["a protocol-relative URL", "[site](//evil.example/x)", "//evil.example/x"],
    ["a GFM autolink literal", "see www.example.com", "http://www.example.com"],
    ["an autolink", "<https://example.com>", "https://example.com"],
  ])("opens %s in a new tab without opener or referrer", (_label, markdown, href) => {
    const [a] = elementsNamed(render(markdown), "a");
    expect(a.attrs.href).toBe(href);
    expect(a.attrs.target).toBe("_blank");
    expect(a.attrs.rel).toBe("noopener noreferrer");
  });

  it("keeps mailto: links in the same tab", () => {
    const [a] = elementsNamed(render("[mail](mailto:it@example.com)"), "a");
    expect(a.attrs.href).toBe("mailto:it@example.com");
    expect(a.attrs.target).toBeUndefined();
  });

  it("renders a fragment link as a plain anchor", () => {
    const [a] = elementsNamed(render("[top](#top)"), "a");
    expect(a.attrs.href).toBe("#top");
    expect(a.attrs.target).toBeUndefined();
  });
});

describe("Markdown: images", () => {
  it("loads lazily, asynchronously and without a referrer", () => {
    const [img] = elementsNamed(render("![Team photo](/uploads/team.jpg)"), "img");
    expect(img.attrs).toMatchObject({
      src: "/uploads/team.jpg",
      alt: "Team photo",
      loading: "lazy",
      decoding: "async",
      referrerpolicy: "no-referrer",
    });
  });
});

describe("Markdown: rendering", () => {
  it("renders GFM (tables, task lists, strikethrough)", () => {
    const html = render("| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n\n~~old~~");
    expect(elementsNamed(html, "table")).toHaveLength(1);
    expect(elementsNamed(html, "input")[0].attrs).toMatchObject({ type: "checkbox" });
    expect(elementsNamed(html, "del")).toHaveLength(1);
  });

  it("uses the prose wrapper by default and the caller's classes on request", () => {
    expect(render("x")).toMatch(/^<div class="prose prose-slate max-w-none dark:prose-invert">/);
    expect(render("x", { className: "prose prose-sm" })).toMatch(/^<div class="prose prose-sm">/);
  });

  it("renders an empty body as an empty wrapper", () => {
    expect(renderToStaticMarkup(createElement(Markdown, null))).toBe(
      '<div class="prose prose-slate max-w-none dark:prose-invert"></div>',
    );
  });

  it("gives headings no ids unless asked (several bodies on one page)", () => {
    const html = render("## Intro");
    expect(elementsNamed(html, "h2")[0].attrs.id).toBeUndefined();
  });

  it("gives headings ids and self-links with headingAnchors", () => {
    const html = render("## Getting started", { headingAnchors: true });
    expect(elementsNamed(html, "h2")[0].attrs.id).toBe("getting-started");
    const [a] = elementsNamed(html, "a");
    expect(a.attrs.href).toBe("#getting-started");
    expect(a.attrs.target).toBeUndefined();
  });

  it("keeps the wiki's table of contents: after the anchors, with its classes", () => {
    const html = render("## One\n\ntext\n\n### Two", {
      headingAnchors: true,
      rehypePlugins: [[rehypeWikiToc, { label: "Contents" }]],
    });
    const [nav] = elementsNamed(html, "nav");
    expect(nav.attrs["aria-label"]).toBe("Contents");
    const tocLinks = elementsNamed(html, "a").filter((a) => a.attrs.class?.includes("text-muted"));
    expect(tocLinks.map((a) => a.attrs.href)).toEqual(["#one", "#two"]);
    expect(html.indexOf("<nav")).toBeLessThan(html.indexOf("<h2"));
  });
});

describe("markdownLinkKind", () => {
  it.each([
    ["", "none"],
    [undefined, "none"],
    ["#section", "fragment"],
    ["/wiki/x", "internal"],
    ["wiki/x", "internal"],
    ["./x", "internal"],
    ["?q=1", "internal"],
    ["/path:with-colon", "internal"],
    ["x?y=a:b", "internal"],
    ["https://example.com", "external"],
    ["HTTP://example.com", "external"],
    ["//example.com", "external"],
    ["\\\\example.com", "external"],
    ["/\\example.com", "external"],
    ["mailto:a@example.com", "other"],
    ["xmpp:a@example.com", "other"],
    ["ircs://irc.example.com", "other"],
  ] as const)("%j is %s", (href, kind) => {
    expect(markdownLinkKind(href)).toBe(kind);
  });
});
