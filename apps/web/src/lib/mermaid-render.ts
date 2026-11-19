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
 *   - no second sanitizer: the SVG string goes straight into React;
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
 * The settings of every render; `startOnLoad` is Mermaid's scan of `.mermaid`
 * elements on page load.
 *
 * Labels are SVG text, not HTML (`htmlLabels: false`, also under `flowchart`,
 * which two code paths read on their own): strict mode keeps the HTML a label
 * carries after DOMPurify (a <form>, an <a>, an <img> that requests its
 * address with the document's referrer), so no label may be HTML. A diagram
 * cannot turn it back on, nor restyle itself: `htmlLabels` (Mermaid checks
 * nested keys too, so `flowchart.htmlLabels` as well), `themeCSS` and the font
 * keys join the keys no diagram can set. Native image shapes
 * (`A@{ img: … }`) still fetch their picture; the document's referrer policy
 * (root layout metadata) is what keeps the intranet's address from it.
 */
export function mermaidConfig(dark: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    secure: [...MERMAID_SECURE_KEYS, "htmlLabels", "themeCSS", "fontFamily", "altFontFamily"],
    theme: dark ? "dark" : "default",
  };
}

/**
 * Mermaid names some elements without its render id (a sequence diagram's
 * `actor0` and `root-0`, a sankey's `node-1` and `linearGradient-5`): two
 * diagrams on a page then repeat them, and a heading that slugs the same
 * would lose its #fragment to the SVG. Every id without the render id gets it
 * as a prefix, and the `url(#…)` and `href="#…"` references to it follow.
 * Only the attributes of tags are read, never a label's text.
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
    const { default: mermaid } = await import("mermaid");
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
