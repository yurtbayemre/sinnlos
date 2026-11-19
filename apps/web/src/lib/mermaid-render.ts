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

/** The settings of every render; `startOnLoad` is Mermaid's scan of `.mermaid` elements on page load. */
export function mermaidConfig(dark: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: dark ? "dark" : "default",
  };
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
 * unmounted block costs no render).
 */
export function renderMermaid(source: string, dark: boolean, signal: AbortSignal): Promise<string> {
  const step = async () => {
    signal.throwIfAborted();
    const { default: mermaid } = await import("mermaid");
    signal.throwIfAborted();
    mermaid.initialize(mermaidConfig(dark));
    const { svg } = await mermaid.render(`sinnlosMermaid${++sequence}`, source);
    return svg;
  };
  const result = queue.then(step);
  queue = result.catch(() => undefined);
  return result;
}
