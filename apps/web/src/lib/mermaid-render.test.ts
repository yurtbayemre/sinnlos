import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import mermaid from "mermaid";
import { describe, expect, it } from "vitest";
import {
  MERMAID_MAX_TEXT_SIZE,
  dropResourceAttribute,
  mermaidConfig,
  namespaceIds,
} from "./mermaid-render";

/**
 * The renderer's settings and the rule that a diagram cannot change them.
 * Mermaid draws SVG only in a browser (it measures text), so what a hostile
 * diagram does to the DOM is e2e/mermaid.spec.ts; here the config logic runs
 * in node: Mermaid merges a diagram's `%%{init}%%` directive and front matter
 * `config:` into its settings while it parses, and drops the `secure` keys on
 * the way (at any depth: `flowchart.htmlLabels` as well as `htmlLabels`). The
 * render queue is mermaid-render-queue.test.ts.
 */

const FLOW = "flowchart TD\n  A --> B";

describe("mermaidConfig", () => {
  it("is strict, never scans the page, throws instead of drawing an error graph, draws labels as text", () => {
    expect(mermaidConfig(false)).toEqual({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      dompurifyConfig: expect.any(Object),
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "suppressErrorRendering",
        "maxEdges",
        "htmlLabels",
        "themeCSS",
        "fontFamily",
        "altFontFamily",
        "dompurifyConfig",
      ],
      theme: "default",
    });
  });

  it("has Mermaid's DOMPurify drop form controls and everything that loads or embeds, in every label", () => {
    // Labels are HTML whatever htmlLabels says in a few places (a sequence message with
    // $$math$$, an event model's data), and DOMPurify keeps all of these by default.
    // Browser check: e2e/mermaid.spec.ts.
    const { FORBID_TAGS, FORBID_ATTR } = mermaidConfig(false).dompurifyConfig ?? {};
    expect(FORBID_TAGS).toEqual(
      expect.arrayContaining([
        "style",
        "form",
        "input",
        "button",
        "textarea",
        "select",
        "option",
        "img",
        "picture",
        "source",
        "video",
        "audio",
        "iframe",
        "object",
        "embed",
        "link",
        "meta",
        "base",
        "image",
        "feImage",
        "use",
      ]),
    );
    // Links stay: Markdown links go anywhere too.
    expect(FORBID_TAGS).not.toContain("a");
    // No attribute is forbidden by name: Mermaid's own markup (an icon's fill, KaTeX's
    // \fcolorbox border) is styled by attributes; dropResourceAttribute drops the ones
    // that load something.
    expect(FORBID_ATTR).toBeUndefined();
  });

  it("keeps every key of the installed Mermaid's own secure list (passing `secure` replaces it)", () => {
    expect(mermaidConfig(false).secure).toEqual(
      expect.arrayContaining(mermaid.mermaidAPI.defaultConfig.secure ?? []),
    );
    expect(mermaid.mermaidAPI.defaultConfig.secure).toContain("securityLevel");
  });

  it("follows the app theme", () => {
    expect(mermaidConfig(true).theme).toBe("dark");
    expect(mermaidConfig(false).theme).toBe("default");
  });

  it("limits the text to Mermaid's maxTextSize", () => {
    expect(MERMAID_MAX_TEXT_SIZE).toBe(mermaid.mermaidAPI.defaultConfig.maxTextSize);
  });
});

describe("a diagram cannot change the settings", () => {
  const configAfterParsing = async (source: string) => {
    mermaid.initialize(mermaidConfig(false));
    await mermaid.parse(source);
    return mermaid.mermaidAPI.getConfig();
  };

  it("keeps the settings of the initialize call (positive control: a directive does set the theme)", async () => {
    const config = await configAfterParsing(`%%{init: {"theme": "forest"}}%%\n${FLOW}`);
    expect(config.theme).toBe("forest");
    expect(config.securityLevel).toBe("strict");
  });

  it.each([
    ["an init directive", `%%{init: {"securityLevel": "loose"}}%%\n${FLOW}`],
    [
      "an init directive that lists the key as nested",
      `%%{init: {"flowchart": {"securityLevel": "loose"}}}%%\n${FLOW}`,
    ],
    [
      "an init directive that empties the secure list first",
      `%%{init: {"secure": [], "securityLevel": "loose"}}%%\n${FLOW}`,
    ],
    ["a front matter config", `---\nconfig:\n  securityLevel: loose\n---\n${FLOW}`],
    [
      "both",
      `---\nconfig:\n  securityLevel: antiscript\n---\n%%{init: {"securityLevel": "loose"}}%%\n${FLOW}`,
    ],
  ])("refuses to lower securityLevel through %s", async (_label, source) => {
    expect((await configAfterParsing(source)).securityLevel).toBe("strict");
  });

  it("refuses the other secure keys too", async () => {
    const config = await configAfterParsing(
      `%%{init: {"startOnLoad": true, "maxTextSize": 999999999, "maxEdges": 999999, "suppressErrorRendering": false}}%%\n${FLOW}`,
    );
    expect(config).toMatchObject({
      startOnLoad: false,
      maxTextSize: MERMAID_MAX_TEXT_SIZE,
      suppressErrorRendering: true,
    });
    expect(config.maxEdges).toBe(mermaid.mermaidAPI.defaultConfig.maxEdges);
  });

  it("does not take a dompurifyConfig from a diagram: ours stays", async () => {
    const config = await configAfterParsing(
      `%%{init: {"dompurifyConfig": {"FORBID_TAGS": [], "ADD_ATTR": ["onerror"]}}}%%\n${FLOW}`,
    );
    expect(config.dompurifyConfig).toEqual(mermaidConfig(false).dompurifyConfig);
    const framed = await configAfterParsing(
      `---\nconfig:\n  dompurifyConfig:\n    FORBID_TAGS: []\n---\n${FLOW}`,
    );
    expect(framed.dompurifyConfig).toEqual(mermaidConfig(false).dompurifyConfig);
  });

  describe("HTML labels, theme CSS and fonts", () => {
    const REENABLE = {
      "an init directive": `%%{init: {"htmlLabels": true, "flowchart": {"htmlLabels": true}, "class": {"htmlLabels": true}}}%%\n${FLOW}`,
      "an init directive for the flowchart only": `%%{init: {"flowchart": {"htmlLabels": true}}}%%\n${FLOW}`,
      "a front matter config": `---\nconfig:\n  htmlLabels: true\n  flowchart:\n    htmlLabels: true\n---\n${FLOW}`,
    };

    it.each(Object.entries(REENABLE))("keeps labels as text against %s", async (_label, source) => {
      const config = await configAfterParsing(source);
      expect(config.htmlLabels).toBe(false);
      expect(config.flowchart?.htmlLabels).toBe(false);
      expect(config.class?.htmlLabels).not.toBe(true);
    });

    it("refuses a diagram's own CSS and fonts (a url() in them would be a request)", async () => {
      const config = await configAfterParsing(
        `%%{init: {"themeCSS": ".node{background:url(https://evil.example/x.png)}", "fontFamily": "evil", "altFontFamily": "evil"}}%%\n${FLOW}`,
      );
      expect(config.themeCSS).toBeUndefined();
      expect(config.altFontFamily).toBeUndefined();
      expect(config.fontFamily).toBe(mermaid.mermaidAPI.defaultConfig.fontFamily);
    });
  });
});

describe("namespaceIds", () => {
  const ROOT = "sinnlosMermaid3";

  it("prefixes the ids that carry no render id and leaves the others", () => {
    const svg =
      `<svg id="${ROOT}"><g id="${ROOT}-flowchart-A-0"></g><title id="chart-title-${ROOT}"></title>` +
      '<line id="actor0" data-id="X"></line><g id="root-0"></g></svg>';
    expect(namespaceIds(svg, ROOT)).toBe(
      `<svg id="${ROOT}"><g id="${ROOT}-flowchart-A-0"></g><title id="chart-title-${ROOT}"></title>` +
        `<line id="${ROOT}-actor0" data-id="X"></line><g id="${ROOT}-root-0"></g></svg>`,
    );
  });

  it("follows the references to a renamed id, and only those", () => {
    const svg =
      '<g><linearGradient id="linearGradient-5"></linearGradient>' +
      '<path stroke="url(#linearGradient-5)"></path><use href="#linearGradient-5"></use>' +
      `<path fill="url(#${ROOT}-marker)"></path><path stroke="url(#other)"></path></g>`;
    expect(namespaceIds(svg, ROOT)).toBe(
      `<g><linearGradient id="${ROOT}-linearGradient-5"></linearGradient>` +
        `<path stroke="url(#${ROOT}-linearGradient-5)"></path><use href="#${ROOT}-linearGradient-5"></use>` +
        `<path fill="url(#${ROOT}-marker)"></path><path stroke="url(#other)"></path></g>`,
    );
  });

  it("never touches a label's text", () => {
    const svg = `<text>see id="actor0" and url(#actor0)</text><line id="actor0"></line>`;
    expect(namespaceIds(svg, ROOT)).toBe(
      `<text>see id="actor0" and url(#actor0)</text><line id="${ROOT}-actor0"></line>`,
    );
  });

  it("is the identity on a svg whose ids all carry the render id", () => {
    const svg = `<svg id="${ROOT}"><g id="${ROOT}-a"></g></svg>`;
    expect(namespaceIds(svg, ROOT)).toBe(svg);
  });
});

describe("dropResourceAttribute", () => {
  /** Whether the rule keeps an attribute: the hook's own `keepAttr` starts true. */
  const kept = (nodeName: string, attrName: string, attrValue: string) => {
    const data = { attrName, attrValue, keepAttr: true };
    dropResourceAttribute({ nodeName }, data);
    return data.keepAttr;
  };

  it.each([
    ["a table's background", "TABLE", "background", "https://evil.example/x.png"],
    ["a cell's background", "TD", "background", "https://evil.example/x.png"],
    ["a srcset", "SPAN", "srcset", "https://evil.example/x.png 2x"],
    ["a poster", "SPAN", "poster", "https://evil.example/x.png"],
    ["an action", "SPAN", "action", "https://evil.example/f"],
    ["a formaction", "SPAN", "formaction", "https://evil.example/f"],
    ["a ping", "SPAN", "ping", "https://evil.example/p"],
    ["a src", "span", "src", "https://evil.example/x.png"],
    ["a src that is no fragment either", "span", "src", "data:image/png;base64,AAAA"],
    ["an href on a non-link", "mi", "href", "https://evil.example/"],
    ["an href on a use", "use", "href", "https://evil.example/s.svg#a"],
    ["an xlink:href on a use", "use", "xlink:href", "https://evil.example/s.svg#a"],
    ["an xlink:href on a feImage", "feImage", "xlink:href", "https://evil.example/x.png"],
    ["an uppercase attribute name", "SPAN", "SRCSET", "https://evil.example/x.png"],
    ["a style with a url()", "span", "style", "background:url(https://evil.example/x.png)"],
    [
      "a style with a quoted url()",
      "span",
      "style",
      "background: URL( 'https://evil.example/x.png' )",
    ],
    ["a style with a data url()", "span", "style", "background:url(data:image/png;base64,AAAA)"],
    [
      "a style with an escaped url()",
      "span",
      "style",
      "background:\\75 rl(https://evil.example/x)",
    ],
    [
      "a style with a url() behind a comment",
      "span",
      "style",
      "background:/**/url(https://e.example/x)",
    ],
    [
      "a style with an image-set()",
      "span",
      "style",
      'background:image-set("https://e.example/x.png" 1x)',
    ],
    ["a fill with a url()", "rect", "fill", "url(https://evil.example/p.svg#a)"],
    ["a stroke with a url()", "rect", "stroke", "url(https://evil.example/p.svg#a)"],
    ["a filter with a url()", "rect", "filter", "url(https://evil.example/f.svg#a)"],
    ["a mask with a url()", "rect", "mask", "url(https://evil.example/m.svg#a)"],
    ["a clip-path with a url()", "rect", "clip-path", "url(https://evil.example/c.svg#a)"],
    ["a marker-end with a url()", "path", "marker-end", "url(https://evil.example/m.svg#a)"],
    [
      "a url() with a fragment first and another target after",
      "rect",
      "fill",
      "url(#a) url(https://e.example/x)",
    ],
    ["a url() with a relative target", "rect", "fill", "url(/uploads/x.svg#a)"],
    ["any other attribute with a url()", "span", "data-x", "url(https://evil.example/x)"],
  ])("drops %s", (_label, nodeName, attrName, attrValue) => {
    expect(kept(nodeName, attrName, attrValue)).toBe(false);
  });

  it.each([
    ["a marker-end to an id", "path", "marker-end", "url(#sinnlosMermaid1_flowchart-v2-pointEnd)"],
    ["a quoted fragment url()", "path", "marker-end", 'url("#a")'],
    ["a single-quoted fragment url() with space", "path", "marker-end", "url( '#a' )"],
    ["a gradient fill", "rect", "fill", "url(#sinnlosMermaid1-linearGradient-5)"],
    ["a gradient stroke", "path", "stroke", "url(#g)"],
    ["a clip-path to an id", "g", "clip-path", "url(#sinnlosMermaid1-clip-0)"],
    ["a style with a fragment url()", "path", "style", "fill:url(#g);stroke:none"],
    ["a style without any url()", "span", "style", "display: flex; align-items: center"],
    ["a fill colour", "rect", "fill", "#9370db"],
    ["a use of an id", "use", "href", "#sinnlosMermaid1-icon"],
    ["an xlink:href to an id", "use", "xlink:href", "#sinnlosMermaid1-icon"],
    ["a link", "a", "href", "https://example.com/page"],
    ["a link in an SVG", "A", "xlink:href", "https://example.com/page"],
    ["a native image shape's picture", "image", "href", "https://example.com/pic.png"],
    ["an image's xlink:href", "image", "xlink:href", "https://example.com/pic.png"],
    ["a class", "span", "class", "node default"],
    ["a title", "span", "title", "Hello"],
    ["path data", "path", "d", "M 0 0 L 10 10"],
    ["a transform", "g", "transform", "translate(10, 20)"],
    ["a width", "mtable", "width", "100%"],
    ["a mathcolor", "mstyle", "mathcolor", "red"],
  ])("keeps %s", (_label, nodeName, attrName, attrValue) => {
    expect(kept(nodeName, attrName, attrValue)).toBe(true);
  });

  it("reaches the DOMPurify that Mermaid sanitizes with: both resolve to the very same file", () => {
    // `dompurify` is one version in the tree, so the hook and Mermaid's own import are one
    // module instance (the bundler dedupes by this real path).
    const own = createRequire(import.meta.url);
    const mermaidRoot = dirname(realpathSync(own.resolve("mermaid/package.json")));
    const theirs = createRequire(join(mermaidRoot, "package.json")).resolve("dompurify");
    expect(realpathSync(own.resolve("dompurify"))).toBe(realpathSync(theirs));
  });
});
