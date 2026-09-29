import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Options as MarkdownOptions } from "react-markdown";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import { describe, expect, it } from "vitest";

import { ICONS } from "@/components/icon-map";

import {
  MAX_WIKI_TAGS,
  collectTocEntries,
  rehypeWikiToc,
  showsToc,
  sortWikiPages,
  wikiSpaceIconName,
  wikiTags,
  type HastNode,
} from "./wiki-content";

/**
 * DA02 (owner answer 2026-09-29 (b)): the wiki page order, table of
 * contents and tags and the space icon are rendered now. The rules live
 * here; the pages only call them.
 */

describe("sortWikiPages", () => {
  const page = (id: number, title: string, order?: number | null) => ({ id, title, order });

  it("sorts by order, then title, then id, without touching the input", () => {
    const pages = [
      page(1, "Zeta", 2),
      page(2, "Alpha", 2),
      page(3, "Beta"),
      page(4, "gamma", 0),
      page(5, "Delta", -1),
      page(6, "Alpha", 2),
      page(7, "Page 10", 1),
      page(8, "Page 9", 1),
    ];
    const before = pages.map((p) => p.id);
    expect(sortWikiPages(pages).map((p) => p.id)).toEqual([5, 3, 4, 8, 7, 2, 6, 1]);
    expect(pages.map((p) => p.id)).toEqual(before);
  });

  it("reads a missing or unusable order as 0", () => {
    const pages = [page(1, "B", null), page(2, "A", Number.NaN), page(3, "C", 0), page(4, "0", -0)];
    expect(sortWikiPages(pages).map((p) => p.title)).toEqual(["0", "A", "B", "C"]);
  });
});

describe("wikiTags", () => {
  it("shows the trimmed strings of a list, once each (case-insensitive), in order", () => {
    expect(
      wikiTags([" runbook", "Onboarding", "runbook", "RUNBOOK", "", "  ", 3, null, "HR"]),
    ).toEqual(["runbook", "Onboarding", "HR"]);
  });

  it("shows nothing for anything but a list", () => {
    for (const value of [null, undefined, "runbook", { 0: "a" }, 42, true]) {
      expect(wikiTags(value), JSON.stringify(value)).toEqual([]);
    }
  });

  it("drops over-long tags and stops at MAX_WIKI_TAGS", () => {
    expect(wikiTags(["x".repeat(101), "ok"])).toEqual(["ok"]);
    const many = Array.from({ length: 30 }, (_, i) => `tag ${i}`);
    expect(wikiTags(many)).toHaveLength(MAX_WIKI_TAGS);
  });
});

describe("wikiSpaceIconName", () => {
  it("takes icon-map names in any case and spelling", () => {
    expect(wikiSpaceIconName("Wrench")).toBe("Wrench");
    expect(wikiSpaceIconName("wrench")).toBe("Wrench");
    expect(wikiSpaceIconName("GraduationCap")).toBe("GraduationCap");
    expect(wikiSpaceIconName("graduation-cap")).toBe("GraduationCap");
    expect(wikiSpaceIconName(" graduation_cap ")).toBe("GraduationCap");
    expect(wikiSpaceIconName("BOOKOPEN")).toBe("BookOpen");
    expect(wikiSpaceIconName("book-open")).toBe("BookOpen");
    expect(wikiSpaceIconName("bar-chart-3")).toBe("BarChart3");
  });

  it("resolves the stored values: the schema default and the demo seed", () => {
    // wiki-space schema.json: "default": "book"; seed-demo.ts: book, code, heart.
    expect(wikiSpaceIconName("book")).toBe("BookOpen");
    expect(wikiSpaceIconName("code")).toBe("Code");
    expect(wikiSpaceIconName("heart")).toBe("Heart");
  });

  it("falls back to BookOpen for anything else, inherited Object keys included (FX27)", () => {
    for (const icon of [
      "rocket",
      "",
      "   ",
      "-",
      null,
      undefined,
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
    ]) {
      expect(wikiSpaceIconName(icon), String(icon)).toBe("BookOpen");
    }
  });

  it("only ever returns a name the icon map renders", () => {
    for (const icon of ["book", "code", "heart", "Wrench", "Calendar", "constructor", "x"]) {
      expect(Object.hasOwn(ICONS, wikiSpaceIconName(icon)), icon).toBe(true);
    }
  });

  it("renders the demo seed's spaces with their own icons, as the wiki pages do", () => {
    const svg = (icon: string) =>
      renderToStaticMarkup(createElement(ICONS[wikiSpaceIconName(icon)], { className: "h-4 w-4" }));
    expect(svg("book")).toContain("lucide-book-open");
    expect(svg("code")).toContain("lucide-code");
    expect(svg("heart")).toContain("lucide-heart");
    expect(svg("unknown")).toContain("lucide-book-open");
  });
});

describe("showsToc", () => {
  it("is on unless switched off (the schema default is true)", () => {
    expect(showsToc(true)).toBe(true);
    expect(showsToc(null)).toBe(true);
    expect(showsToc(undefined)).toBe(true);
    expect(showsToc(false)).toBe(false);
  });
});

describe("collectTocEntries", () => {
  const text = (value: string): HastNode => ({ type: "text", value });
  const el = (tagName: string, properties: Record<string, unknown>, children: HastNode[]) => ({
    type: "element",
    tagName,
    properties,
    children,
  });

  it("takes h2 and h3 with an id and text, in document order, nested ones included", () => {
    const tree: HastNode = {
      type: "root",
      children: [
        el("h1", { id: "title" }, [text("Title")]),
        el("h2", { id: "setup" }, [el("a", { href: "#setup" }, [text("Set "), text("up")])]),
        el("section", {}, [el("h3", { id: "linux" }, [text("  Linux\n  hosts ")])]),
        el("h4", { id: "deep" }, [text("Deep")]),
        el("h2", {}, [text("No id")]),
        el("h2", { id: "empty" }, []),
      ],
    };
    expect(collectTocEntries(tree)).toEqual([
      { id: "setup", text: "Set up", depth: 2 },
      { id: "linux", text: "Linux hosts", depth: 3 },
    ]);
  });
});

describe("rehypeWikiToc in the page's Markdown pipeline", () => {
  const render = (markdown: string, toc = true) => {
    const rehypePlugins: NonNullable<MarkdownOptions["rehypePlugins"]> = [
      rehypeSlug,
      [rehypeAutolinkHeadings, { behavior: "wrap" }],
    ];
    if (toc) rehypePlugins.push([rehypeWikiToc, { label: "Contents" }]);
    return renderToStaticMarkup(createElement(ReactMarkdown, { rehypePlugins }, markdown));
  };

  const BODY = [
    "# Handbook",
    "Intro.",
    "## Getting started",
    "### On Linux",
    "## Getting started",
    "## Ünïcode & *emphasis*",
  ].join("\n\n");

  it("puts a list of links to the headings' own ids first, named by the given label", () => {
    const html = render(BODY);
    expect(html.startsWith('<nav aria-label="Contents"')).toBe(true);
    const links = [...html.matchAll(/<li[^>]*><a href="#([^"]+)"[^>]*>([^<]*)<\/a><\/li>/g)].map(
      ([, href, label]) => [href, label],
    );
    expect(links).toEqual([
      ["getting-started", "Getting started"],
      ["on-linux", "On Linux"],
      ["getting-started-1", "Getting started"],
      ["ünïcode--emphasis", "Ünïcode &amp; emphasis"],
    ]);
    // Every link target exists as a heading id (rehype-slug gave them).
    for (const [href] of links) expect(html).toContain(`id="${href}"`);
    expect(html).toContain('<li class="ml-4"><a href="#on-linux"');
  });

  it("adds nothing for fewer than two headings, or when the page turns it off", () => {
    expect(render("# Title\n\n## Only one\n\ntext")).not.toContain("<nav");
    expect(render(BODY, false)).not.toContain("<nav");
  });
});
