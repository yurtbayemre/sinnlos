import { describe, expect, it } from "vitest";
import { safeInternalPath, stripMarkdown } from "./utils";

/**
 * `safeInternalPath` is the open-redirect guard for every ?from= value (the
 * sign-in page and both sign-in actions). The sign-in page passes the result
 * straight to redirect() for an already signed-in user, and Next copies it
 * verbatim into the Location header — so anything a BROWSER resolves to a
 * foreign origin is an open redirect.
 *
 * FX10: the old prefix checks rejected "//host" and "/\host" but passed
 * "/<TAB>/evil.example": browsers strip TAB/LF/CR while parsing, which turns
 * it into the protocol-relative "//evil.example". These tests pin
 *   1. the attack premise itself (WHATWG URL parsing, as browsers do it),
 *   2. rejection of protocol-relative, backslash, control-character and
 *      dot-segment shapes, non-strings and non-paths,
 *   3. the /sign-in and /register exclusions incl. query/hash suffixes,
 *   4. that real deep links (query strings, hashes, encoded characters)
 *      pass through unchanged.
 */

const SITE = "https://intranet.example";

/** Where a browser would land for a Location header of `value` on SITE. */
const browserTarget = (value: string) => new URL(value, `${SITE}/sign-in`);

describe("attack premise (WHATWG URL parsing, as in the browser)", () => {
  it("strips TAB/LF/CR, turning a slash-control-slash path into another host", () => {
    for (const ctl of ["\t", "\n", "\r"]) {
      expect(browserTarget(`/${ctl}/evil.example/x`).host).toBe("evil.example");
    }
  });

  it("treats a backslash like a slash in http(s) URLs", () => {
    expect(browserTarget("/\\evil.example/x").host).toBe("evil.example");
  });

  it("normalises dot segments into a protocol-relative-looking pathname", () => {
    expect(new URL("/x/..//evil.example", SITE).pathname).toBe("//evil.example");
  });
});

describe("safeInternalPath — rejected values fall back", () => {
  it("rejects non-string input", () => {
    for (const value of [undefined, null, 42, true, {}, ["/wiki"], new URL(SITE)]) {
      expect(safeInternalPath(value)).toBe("/");
    }
  });

  it("uses the supplied fallback", () => {
    expect(safeInternalPath(undefined, "/dashboard")).toBe("/dashboard");
    expect(safeInternalPath("//evil.example", "/dashboard")).toBe("/dashboard");
  });

  it("rejects values that are not absolute paths", () => {
    for (const value of [
      "",
      "wiki",
      "evil.example/x",
      "https://evil.example",
      "http://evil.example/x",
      "javascript:alert(1)",
      "?from=/x",
      "#top",
    ]) {
      expect(safeInternalPath(value)).toBe("/");
    }
  });

  it("rejects protocol-relative //host", () => {
    for (const value of ["//evil.example", "//evil.example/x", "///evil.example"]) {
      expect(safeInternalPath(value)).toBe("/");
    }
  });

  it("rejects a backslash anywhere", () => {
    for (const value of ["/\\evil.example", "/\\/evil.example", "/wiki\\page", "/wiki/\\"]) {
      expect(safeInternalPath(value)).toBe("/");
    }
  });

  it("rejects slash-TAB-slash and slash-TAB-backslash host shapes (FX10)", () => {
    expect(safeInternalPath("/\t/evil.example/x")).toBe("/");
    expect(safeInternalPath("/\t\\evil.example/x")).toBe("/");
    expect(safeInternalPath("/\t\t/evil.example")).toBe("/");
  });

  it("rejects CR/LF variants (redirect and header-injection shapes)", () => {
    for (const value of [
      "/\n/evil.example",
      "/\r/evil.example",
      "/\r\n/evil.example",
      "/wiki\r\nSet-Cookie: x=1",
      "/wiki\n",
    ]) {
      expect(safeInternalPath(value)).toBe("/");
    }
  });

  it("rejects every other C0 control character and DEL", () => {
    for (const code of [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x1b, 0x1f, 0x7f]) {
      expect(safeInternalPath(`/${String.fromCharCode(code)}/evil.example`)).toBe("/");
    }
  });

  it("rejects dot-segment paths that normalise to //host", () => {
    expect(safeInternalPath("/x/..//evil.example")).toBe("/");
    expect(safeInternalPath("/./..//evil.example/x")).toBe("/");
  });

  it("excludes /sign-in and /register, including query and hash suffixes", () => {
    for (const value of [
      "/sign-in",
      "/sign-in?x",
      "/sign-in?expired=1",
      "/sign-in?from=/wiki",
      "/sign-in#top",
      "/wiki/../sign-in",
      "/register",
      "/register?x=1",
    ]) {
      expect(safeInternalPath(value)).toBe("/");
    }
  });
});

describe("safeInternalPath — valid deep links pass through unchanged", () => {
  const valid = [
    "/",
    "/wiki/onboarding",
    "/wiki/onboarding?tab=history",
    "/people/42?from=directory#contact",
    "/marketplace?category=furniture&page=2#listing-7",
    "/search?q=a%20b&type=wiki",
    "/events/abc123/ics",
    // Auth-page lookalikes are ordinary paths.
    "/sign-in-help",
    "/registered",
    // Percent-encoded slashes/controls are data, not separators: the browser
    // keeps them in the path of the SAME origin.
    "/%2F%2Fevil.example",
    "/%09/evil.example",
  ];

  it("returns the value as given", () => {
    for (const value of valid) {
      expect(safeInternalPath(value)).toBe(value);
    }
  });

  it("every accepted value stays on the site origin when a browser resolves it", () => {
    for (const value of valid) {
      expect(browserTarget(safeInternalPath(value)).origin).toBe(SITE);
    }
  });
});

/**
 * stripMarkdown (UI03): a Markdown body as one line of plain text for the
 * dashboard's LatestNews excerpts, which showed the raw source. The words
 * stay, the syntax and every URL go.
 */
describe("stripMarkdown", () => {
  it("answers an empty string for nothing", () => {
    for (const value of [undefined, null, "", "   \n\n "]) expect(stripMarkdown(value)).toBe("");
  });

  it("keeps plain text, collapsing whitespace and line breaks", () => {
    expect(stripMarkdown("Join us at 15:00 CET.\nAgenda:  numbers,\n\nroadmap")).toBe(
      "Join us at 15:00 CET. Agenda: numbers, roadmap",
    );
  });

  it("removes headings, emphasis, strikethrough and inline code markers", () => {
    expect(
      stripMarkdown(
        "# Welcome\n\nThis is **self-hosted**, _fast_ and *simple*; ~~old~~ `in:handbook`",
      ),
    ).toBe("Welcome This is self-hosted, fast and simple; old in:handbook");
    expect(stripMarkdown("## Rules ##\n### Deep")).toBe("Rules Deep");
    expect(stripMarkdown("__bold__ and ***both***")).toBe("bold and both");
  });

  it("keeps link and image text, never their targets", () => {
    expect(
      stripMarkdown(
        'Read [the wiki](/wiki/eng "Engineering") and ![a chart](https://cdn.example/c.png), ' +
          "[ref link][r], <https://example.com/x> or <it@example.com>\n\n[r]: https://example.com",
      ),
    ).toBe("Read the wiki and a chart, ref link, https://example.com/x or it@example.com");
    expect(stripMarkdown("[click](javascript:alert(1))")).toBe("click");
  });

  it("removes list, task, quote, rule and table syntax", () => {
    expect(stripMarkdown("- one\n* two\n+ three\n1. four\n2) five")).toBe(
      "one two three four five",
    );
    expect(stripMarkdown("- [x] done\n- [ ] open")).toBe("done open");
    expect(stripMarkdown("> quoted\n> > nested\n\n---\n\n***\nafter")).toBe("quoted nested after");
    expect(stripMarkdown("| a | b |\n| :- | -: |\n| 1 | 2 |")).toBe("a b 1 2");
    expect(stripMarkdown("Title\n=====\nSub\n---")).toBe("Title Sub");
  });

  it("drops code fences but keeps the code", () => {
    expect(stripMarkdown('Run:\n```ts\nconsole.log("hi");\n```\ndone')).toBe(
      'Run: console.log("hi"); done',
    );
  });

  it("drops raw HTML tags and comments, not a lone angle bracket", () => {
    expect(stripMarkdown('<p onclick="x()">Hi</p><br/><!-- note -->there')).toBe("Hithere");
    expect(stripMarkdown("<script>alert(1)</script>")).toBe("alert(1)");
    expect(stripMarkdown("a < b and c > d")).toBe("a < b and c > d");
  });

  it("keeps escaped characters and what only looks like syntax", () => {
    expect(stripMarkdown("\\*not emphasis\\* and \\# no heading")).toBe(
      "*not emphasis* and # no heading",
    );
    expect(stripMarkdown("snake_case_name, 2 * 3 * 4, #hashtag, C#")).toBe(
      "snake_case_name, 2 * 3 * 4, #hashtag, C#",
    );
    expect(stripMarkdown("`**literal**` and `a\\*b`")).toBe("**literal** and a*b");
  });

  it("never leaves its internal markers behind", () => {
    const out = stripMarkdown("x `\\*` \\_ [a](b)");
    expect(out).not.toMatch(/[]/);
    expect(out).toBe("x * _ a");
  });

  it("turns the demo announcements into readable excerpts", () => {
    expect(
      stripMarkdown(
        "Hit ⌘K anywhere in the app to fuzzy search wiki pages, people and teams. Special filters: `in:handbook`, `by:@grace`, `tag:runbook`.",
      ),
    ).toBe(
      "Hit ⌘K anywhere in the app to fuzzy search wiki pages, people and teams. Special filters: in:handbook, by:@grace, tag:runbook.",
    );
  });
});
