import type { MermaidConfig } from "mermaid";

/**
 * Mermaid in Markdown (v1.1 "Tools"): the one place that loads and configures
 * the renderer. Browser only: Mermaid needs a DOM, and the dynamic `import()`
 * below runs only when a mermaid fence has mounted (components/mermaid-block.tsx),
 * so no page without a fence ever fetches the library.
 *
 * Safety rules (pinned by mermaid-render.test.ts and e2e/mermaid.spec.ts):
 *
 *   - `securityLevel: "strict"`: labels pass Mermaid's DOMPurify, click
 *     callbacks are never bound, `javascript:` link targets become
 *     about:blank. A diagram cannot raise it: a `%%{init: …}%%` directive or
 *     a front matter `config:` block cannot set a key in Mermaid's `secure`
 *     list (securityLevel, startOnLoad, maxTextSize, suppressErrorRendering,
 *     maxEdges), they are dropped before they merge;
 *   - no second sanitize pass: the SVG string goes straight into React. What
 *     Mermaid's own DOMPurify lets through is narrowed in place (a config for
 *     label text, one attribute hook; see `dropResourceAttribute`);
 *   - `suppressErrorRendering`: a diagram that does not parse throws and
 *     leaves no "bomb" error graph in <body> (Mermaid otherwise draws one
 *     and leaves its temporary element behind).
 */

/** Mermaid's own limit (`maxTextSize`); a longer text renders as an error graph there. */
export const MERMAID_MAX_TEXT_SIZE = 50_000;

/**
 * Mermaid 12.3.0's own `secure` list: what a diagram's `%%{init}%%` or front
 * matter can never set. Passing `secure` REPLACES the list, so these stay in
 * it (the test pins that no key of the installed version is missing).
 */
const MERMAID_SECURE_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
];

/**
 * What Mermaid's DOMPurify may not leave in label text (`sanitizeText` takes
 * this as `dompurifyConfig`, in place of its own `FORBID_TAGS: ["style"]`, so
 * `style` stays): form controls, and every element that loads or embeds
 * something. DOMPurify keeps all of these by default, and some labels are HTML
 * whatever `htmlLabels` says (a sequence message with `$$math$$`, an event
 * model's data). `a` stays: Markdown links go anywhere too. `image` goes from
 * labels only: a native image shape (`A@{ img: … }`) is made by Mermaid itself,
 * never passes through label text, and fetches its picture while it is drawn
 * (the root referrer policy keeps the origin from it); `dropResourceAttribute`
 * therefore leaves an `image`'s own address alone.
 */
const FORBIDDEN_LABEL_TAGS = [
  "style",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "optgroup",
  "img",
  "picture",
  "source",
  "track",
  "video",
  "audio",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "link",
  "meta",
  "base",
  "image",
  "feImage",
  "use",
];

/**
 * The part of DOMPurify's `uponSanitizeAttribute` event the rule reads and
 * writes (`keepAttr = false` removes the attribute).
 */
export interface AttributeEvent {
  attrName: string;
  attrValue: string;
  keepAttr?: boolean;
}

/** Attributes that make a browser fetch something, whatever they hold. */
const RESOURCE_ATTRIBUTES = new Set([
  "background",
  "srcset",
  "poster",
  "action",
  "formaction",
  "ping",
]);
/** Attributes that name one address; only a `#fragment` stays inside the document. */
const ADDRESS_ATTRIBUTES = new Set(["src", "href", "xlink:href"]);

/** A CSS value as the browser reads it: escapes decoded, comments gone. */
function cssText(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) =>
      String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)),
    )
    .replace(/\\(.)/gs, "$1");
}

/**
 * DOMPurify keeps the attributes that load something (a table's `background`,
 * `srcset`, a `style` or an SVG `fill`/`filter`/`mask`/`clip-path`/`marker-*`
 * with a `url(...)`), whatever the tag allowlist says, and strict mode runs it
 * over every label and over the whole SVG. This drops them all, in one place:
 * `keepAttr = false` for
 *   - `background`, `srcset`, `poster`, `action`, `formaction`, `ping`;
 *   - `src`, `href` and `xlink:href` that are not a `#fragment`, except an
 *     `a`'s link (DOMPurify's own scheme check applies to it, and following
 *     a link is the reader's act) and an `image`'s own address (a native image
 *     shape is made by Mermaid itself and fetched before any sanitizer runs);
 *   - any attribute holding a `url(...)` with a target other than a
 *     `#fragment`, or an `image-set(...)`: markers, gradients, clip paths and
 *     filters that Mermaid draws point at `#ids` and stay.
 * Generated styles and fills are untouched.
 */
export function dropResourceAttribute(node: { nodeName: string }, data: AttributeEvent): void {
  const name = data.attrName.toLowerCase();
  const tag = node.nodeName.toLowerCase();
  if (tag === "a" && (name === "href" || name === "xlink:href")) return;
  if (RESOURCE_ATTRIBUTES.has(name)) {
    data.keepAttr = false;
  } else if (ADDRESS_ATTRIBUTES.has(name)) {
    if (tag !== "image" && !data.attrValue.trim().startsWith("#")) data.keepAttr = false;
  } else {
    const css = cssText(data.attrValue);
    const pointsOut = [...css.matchAll(/url\(\s*(["']?)\s*(#?)/gi)].some(
      (match) => match[2] === "",
    );
    if (pointsOut || /image-set\(/i.test(css)) data.keepAttr = false;
  }
}

let hooked = false;

/**
 * Registers the rule once with the DOMPurify instance Mermaid sanitizes with:
 * `dompurify` is one exact version in the tree (Mermaid's own), so both
 * imports resolve to the same file and one module (pinned by a test). It is
 * loaded here, not at the top: the library belongs to the lazy chunk. Nothing
 * else of the web uses DOMPurify, so a global hook touches no other consumer.
 */
async function loadDomPurify(): Promise<void> {
  const { default: DOMPurify } = await import("dompurify");
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("uponSanitizeAttribute", dropResourceAttribute);
}

/**
 * The settings of every render; `startOnLoad` is Mermaid's scan of `.mermaid`
 * elements on page load.
 *
 * Labels are SVG text, not HTML (`htmlLabels: false`, also under `flowchart`,
 * which two code paths read on their own): strict mode keeps the HTML a label
 * carries after DOMPurify (a <form>, an <a>, an <img> that requests its
 * address with the document's referrer), so no label may be HTML. The cost:
 * `$$math$$` is drawn only where the renderer makes it HTML anyway (sequence
 * messages), a flowchart label shows it as text. A diagram cannot turn the
 * setting back on, nor restyle itself: `htmlLabels` (Mermaid checks nested
 * keys too, so `flowchart.htmlLabels` as well), `themeCSS`, the font keys and
 * `dompurifyConfig` join the keys no diagram can set (`dompurifyConfig` is no
 * config key of Mermaid yet, so a diagram's one is dropped today). Native
 * image shapes (`A@{ img: … }`) still fetch their picture; the referrer policy
 * of the (app) layout is what keeps the intranet's address from it.
 */
export function mermaidConfig(dark: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    dompurifyConfig: { FORBID_TAGS: FORBIDDEN_LABEL_TAGS },
    secure: [
      ...MERMAID_SECURE_KEYS,
      "htmlLabels",
      "themeCSS",
      "fontFamily",
      "altFontFamily",
      "dompurifyConfig",
    ],
    theme: dark ? "dark" : "default",
  };
}

/**
 * Mermaid names some elements without its render id (a sequence diagram's
 * `actor0` and `root-0`, a sankey's `node-1` and `linearGradient-5`): two
 * diagrams on a page then repeat them, and a heading that slugs the same
 * would lose its #fragment to the SVG. Every id without the render id gets it
 * as a prefix, and the `url(#…)` and `href="#…"` references to it follow.
 * Only the attributes of tags are read, never a label's text. Not covered, as
 * no Mermaid 12.3.0 diagram of ~75 rendered (every type) emits one: a quoted
 * `url("#…")` and a `url(#…)` inside `<style>` text; extend if one does.
 */
export function namespaceIds(svg: string, root: string): string {
  const tag = /<[a-zA-Z][^<>]*>/g;
  const renamed = new Set<string>();
  const named = svg.replace(tag, (element) =>
    element.replace(/(\sid=")([^"]+)"/, (whole, head: string, id: string) => {
      if (id.includes(root)) return whole;
      renamed.add(id);
      return `${head}${root}-${id}"`;
    }),
  );
  if (renamed.size === 0) return named;
  return named.replace(tag, (element) =>
    element.replace(/(url\(#|href="#)([^)"]+)/g, (whole, head: string, id: string) =>
      renamed.has(id) ? `${head}${root}-${id}` : whole,
    ),
  );
}

// Mermaid draws into a temporary element of <body>, and its theme is global
// state: initialize + render run as one step, one diagram after the other.
let queue: Promise<unknown> = Promise.resolve();
// The render id becomes an element id and a CSS selector; Mermaid REMOVES any
// element of the page with that id first. camelCase cannot clash with the
// lower-case ids of headings (rehype-slug) or footnotes.
let sequence = 0;

/**
 * The SVG of one diagram, as a string for React to set. Rejects when the
 * diagram does not parse, or when `signal` aborted before its turn (an
 * unmounted block costs no render; one that already runs cannot be cut short).
 *
 * shortcut: no render time limit. Mermaid draws on the main thread, so a
 * mindmap of ~2,500 nodes (19,000 characters, far under the size limit) hangs
 * the tab; a worker is no option (it needs the DOM). Upgrade if authors build
 * diagrams that large; the author sees the hang first, in the preview.
 */
export function renderMermaid(source: string, dark: boolean, signal: AbortSignal): Promise<string> {
  const step = async () => {
    signal.throwIfAborted();
    const [{ default: mermaid }] = await Promise.all([import("mermaid"), loadDomPurify()]);
    signal.throwIfAborted();
    mermaid.initialize(mermaidConfig(dark));
    const id = `sinnlosMermaid${++sequence}`;
    const { svg } = await mermaid.render(id, source);
    return namespaceIds(svg, id);
  };
  const result = queue.then(step);
  queue = result.catch(() => undefined);
  return result;
}
