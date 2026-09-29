import Link from "next/link";
import type { Route } from "next";
import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components, type ExtraProps, type Options } from "react-markdown";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import type { HastNode } from "@/lib/wiki-content";

/**
 * The one Markdown renderer of the web (UI03): wiki pages, lessons and
 * announcements (Strapi `richtext` fields hold Markdown). Safety rules, all
 * pinned by markdown.test.ts:
 *
 *   - react-markdown + remark-gfm, NO rehype-raw: raw HTML in a body is
 *     never parsed; it is shown as literal text (react-markdown turns the
 *     `raw` nodes into text), so `<script>` or an `onerror` attribute never
 *     becomes an element or an attribute;
 *   - react-markdown's default urlTransform on every URL attribute (href,
 *     src, …): only http(s), mailto, xmpp and irc(s) URLs and relative
 *     references survive, anything else (javascript:, vbscript:, data:, …)
 *     becomes "" — such a link renders as plain text, such an image as its
 *     alt text;
 *   - links: in-app references go through next/link (client navigation,
 *     no prefetch — a long page would prefetch every link it shows),
 *     `#fragment` links (the wiki TOC, heading anchors, footnotes) stay
 *     plain anchors, http(s) and protocol-relative links open in a new tab
 *     with rel="noopener noreferrer";
 *   - images: loading="lazy", decoding="async" and referrerPolicy
 *     "no-referrer" (an external image host learns no intranet URL).
 *
 * Several bodies on one page (announcement cards) pass `idPrefix`: GFM
 * footnotes otherwise get the same ids in every body (user-content-fn-1),
 * and a card's footnote links would jump to the first card's notes.
 *
 * A server component (no hooks), usable from client components as well.
 */

/** How the renderer treats a link target after the urlTransform. */
export type MarkdownLinkKind = "none" | "fragment" | "internal" | "external" | "other";

/**
 * The kind of a link target, AFTER react-markdown's urlTransform (so it is
 * "", relative, or one of http, https, mailto, xmpp, irc, ircs):
 *   - none: empty (the transform dropped an unsafe URL);
 *   - fragment: "#…", a target on this page;
 *   - external: http(s) URLs and protocol-relative "//host" (also a
 *     backslash spelling, which browsers read as "//");
 *   - other: mailto:, xmpp:, irc(s): — plain anchors, no new tab;
 *   - internal: everything else — a same-origin path ("/wiki/x", "x",
 *     "?q=1").
 * The scheme test mirrors react-markdown's defaultUrlTransform: a colon
 * after the first "/", "?" or "#" is part of a relative reference.
 */
export function markdownLinkKind(href: string | null | undefined): MarkdownLinkKind {
  if (typeof href !== "string" || href === "") return "none";
  if (href.startsWith("#")) return "fragment";
  if (/^[/\\]{2}/.test(href)) return "external";
  const colon = href.indexOf(":");
  const firstDelimiter = [href.indexOf("/"), href.indexOf("?"), href.indexOf("#")]
    .filter((index) => index !== -1)
    .reduce((min, index) => Math.min(min, index), Infinity);
  if (colon === -1 || colon > firstDelimiter) return "internal";
  const scheme = href.slice(0, colon).toLowerCase();
  return scheme === "http" || scheme === "https" ? "external" : "other";
}

type AnchorProps = ComponentPropsWithoutRef<"a"> & ExtraProps;
type ImageProps = ComponentPropsWithoutRef<"img"> & ExtraProps;

/** The props without react-markdown's hast `node` (never a DOM attribute). */
function domProps<T extends ExtraProps>(props: T): Omit<T, "node"> {
  const rest = { ...props };
  delete rest.node;
  return rest;
}

function MarkdownLink(props: AnchorProps) {
  const { href, children, ...rest } = domProps(props);
  switch (markdownLinkKind(href)) {
    case "none":
      // A neutralised URL: the text stays, the link does not.
      return <span>{children}</span>;
    case "internal":
      return (
        <Link href={href as Route} prefetch={false} {...rest}>
          {children}
        </Link>
      );
    case "external":
      return (
        <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    default:
      return (
        <a {...rest} href={href}>
          {children}
        </a>
      );
  }
}

function MarkdownImage(props: ImageProps) {
  const { src, alt, ...rest } = domProps(props);
  // A neutralised or missing source: the alt text stands in (React would
  // warn about an empty src and the browser would request the page).
  if (typeof src !== "string" || src === "") return alt ? <span>{alt}</span> : null;
  return (
    // Markdown images have no known size, which next/image needs.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...rest}
      src={src}
      alt={alt ?? ""}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
    />
  );
}

const COMPONENTS: Components = { a: MarkdownLink, img: MarkdownImage };

/** A list of rehype plugins (with their options), as react-markdown takes it. */
export type MarkdownRehypePlugins = NonNullable<Options["rehypePlugins"]>;

/** rehype-slug ids on the headings, and each heading wrapped in its own anchor link. */
const HEADING_ANCHORS: MarkdownRehypePlugins = [
  rehypeSlug,
  [rehypeAutolinkHeadings, { behavior: "wrap" }],
];

/** The id mdast-util-to-hast always gives the footnote section's heading. */
const FOOTNOTE_LABEL_ID = "footnote-label";

/**
 * A rehype plugin: `prefix` in front of the footnote section's heading id,
 * which mdast-util-to-hast never prefixes (clobberPrefix covers only the
 * fn-/fnref- ids), and in the footnote references' aria-describedby that
 * names it. Runs before rehype-slug, so a heading that slugs to the same
 * text keeps its own id. Raw HTML is never parsed, so no other element can
 * carry these ids.
 */
function rehypeFootnoteLabelPrefix(options: { prefix: string }) {
  const id = `${options.prefix}${FOOTNOTE_LABEL_ID}`;
  const visit = (node: HastNode): void => {
    const properties = node.properties;
    if (properties) {
      if (properties.id === FOOTNOTE_LABEL_ID) properties.id = id;
      const describedBy = properties.ariaDescribedBy;
      if (Array.isArray(describedBy)) {
        properties.ariaDescribedBy = describedBy.map((value) =>
          value === FOOTNOTE_LABEL_ID ? id : value,
        );
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  return (tree: HastNode): void => visit(tree);
}

const footnoteLabelPrefix = (prefix: string): MarkdownRehypePlugins => [
  [rehypeFootnoteLabelPrefix, { prefix }],
];

/** The typography of long-form bodies (wiki page, lesson). */
export const PROSE_CLASS = "prose prose-slate max-w-none dark:prose-invert";

export function Markdown({
  children,
  className = PROSE_CLASS,
  headingAnchors = false,
  idPrefix,
  rehypePlugins = [],
}: {
  /** The Markdown source; empty or missing renders an empty wrapper. */
  children?: string | null;
  /** The wrapper's classes (default: {@link PROSE_CLASS}). */
  className?: string;
  /**
   * Heading ids and self-links (rehype-slug + rehype-autolink-headings).
   * Only for a page with ONE body: several bodies on a page (announcement
   * cards) would repeat the ids.
   */
  headingAnchors?: boolean;
  /**
   * Prefix of the footnote ids and their links, the footnote section's
   * heading included (without it: "user-content-fn-1" and a bare
   * "footnote-label"). One per body on a page with several bodies, e.g.
   * "announcement-12-".
   */
  idPrefix?: string;
  /** Further rehype plugins, run after the heading anchors (the wiki TOC). */
  rehypePlugins?: MarkdownRehypePlugins;
}) {
  return (
    <div className={cn(className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        remarkRehypeOptions={idPrefix ? { clobberPrefix: idPrefix } : undefined}
        rehypePlugins={[
          ...(idPrefix ? footnoteLabelPrefix(idPrefix) : []),
          ...(headingAnchors ? HEADING_ANCHORS : []),
          ...rehypePlugins,
        ]}
        components={COMPONENTS}
      >
        {children ?? ""}
      </ReactMarkdown>
    </div>
  );
}
