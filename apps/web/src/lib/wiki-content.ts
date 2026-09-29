/**
 * The wiki fields that used to be stored but never shown (DA02; owner answer
 * 2026-09-29 (b): implement all four): a page's `order`, `tocEnabled` and
 * `tags`, and a space's `icon`. Pure helpers, so the pages stay thin and the
 * rules are testable (wiki-content.test.ts):
 *   - sortWikiPages: a space lists its pages by `order` ascending, ties (and
 *     pages without one) by title, then id;
 *   - wikiTags: the tags a page shows as chips, from a JSON value that may
 *     hold anything (the admin panel writes free JSON);
 *   - wikiSpaceIconName: a space's icon as a name of the shared icon map,
 *     in any letter case, with or without separators ("wrench",
 *     "book-open"), the stored default "book" included, BookOpen for
 *     anything the map does not know (the page renders ICONS[name], a
 *     static component, not one made during render);
 *   - rehypeWikiToc: the table of contents, built inside the Markdown
 *     pipeline from the headings rehype-slug has given ids, so every link
 *     matches its heading exactly. It adds no text of its own (no new
 *     message key): the list is labelled with the page title.
 */
import { ICONS, isIconName, type IconName } from "@/components/icon-map";

// ---------------------------------------------------------------------------
// Page order
// ---------------------------------------------------------------------------

/** The part of a page the list order reads. */
export interface OrderedPage {
  id: number;
  title: string;
  order?: number | null;
}

const orderOf = (page: OrderedPage): number =>
  typeof page.order === "number" && Number.isFinite(page.order) ? page.order : 0;

const titleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The pages by `order` (missing = 0), then title, then id; a new array. */
export function sortWikiPages<T extends OrderedPage>(pages: readonly T[]): T[] {
  return [...pages].sort(
    (a, b) => orderOf(a) - orderOf(b) || titleCollator.compare(a.title, b.title) || a.id - b.id,
  );
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** Most chips a page shows. */
export const MAX_WIKI_TAGS = 20;
/** Longest tag shown (the cms write allowlist accepts up to 100 characters). */
export const MAX_WIKI_TAG_LENGTH = 100;

/**
 * The tags to show: the strings of a JSON list, trimmed, without blanks,
 * over-long values and case-insensitive repeats (the first spelling wins),
 * at most MAX_WIKI_TAGS. Anything that is not a list shows no tags.
 */
export function wikiTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const tag = item.trim();
    if (tag === "" || tag.length > MAX_WIKI_TAG_LENGTH) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === MAX_WIKI_TAGS) break;
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Space icon
// ---------------------------------------------------------------------------

/** The icon of a space without a usable one (the wiki's icon before DA02). */
export const DEFAULT_WIKI_SPACE_ICON: IconName = "BookOpen";

/** A stored icon value as a lookup key: lower case, without separators. */
const iconKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

/**
 * Stored values that name an icon by another word: the wiki-space schema
 * default "book" (every space created before DA02 carries it).
 */
const WIKI_SPACE_ICON_ALIASES: Readonly<Record<string, IconName>> = { book: "BookOpen" };

/**
 * Every icon-map name and alias by its lookup key. A Map, not an object,
 * so "constructor" or "__proto__" can never resolve to an inherited value
 * (FX27): the keys come from the map's own keys only.
 */
const WIKI_SPACE_ICONS: ReadonlyMap<string, IconName> = new Map<string, IconName>([
  ...Object.keys(ICONS)
    .filter(isIconName)
    .map((name): [string, IconName] => [iconKey(name), name]),
  ...Object.entries(WIKI_SPACE_ICON_ALIASES),
]);

/**
 * The icon of a space as an icon-map name. The admin panel takes free
 * text, so a map name resolves in any letter case and with or without
 * hyphens, underscores or spaces ("Wrench", "wrench", "BOOKOPEN",
 * "book-open", "graduation_cap"), and so do the values already stored: the
 * schema default "book" (BookOpen) and the demo seed's "code" and "heart"
 * (Code and Heart are in the map for them). Anything else is BookOpen, the
 * wiki's icon before DA02.
 */
export function wikiSpaceIconName(icon: string | null | undefined): IconName {
  if (typeof icon !== "string") return DEFAULT_WIKI_SPACE_ICON;
  return WIKI_SPACE_ICONS.get(iconKey(icon)) ?? DEFAULT_WIKI_SPACE_ICON;
}

// ---------------------------------------------------------------------------
// Table of contents
// ---------------------------------------------------------------------------

/** A hast node, as far as the TOC plugin reads and writes it. */
export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export interface TocEntry {
  id: string;
  text: string;
  depth: 2 | 3;
}

/** Fewest headings that make a table of contents worth showing. */
export const TOC_MIN_ENTRIES = 2;

const HEADING_DEPTH: Record<string, 2 | 3> = { h2: 2, h3: 3 };

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/**
 * The h2 and h3 headings of a hast tree in document order, with the ids
 * rehype-slug gave them; a heading without an id or without text is left
 * out. `#` headings are the page title's level and stay out.
 */
export function collectTocEntries(tree: HastNode): TocEntry[] {
  const entries: TocEntry[] = [];
  const visit = (node: HastNode) => {
    const depth = node.type === "element" && node.tagName ? HEADING_DEPTH[node.tagName] : undefined;
    if (depth) {
      const id = node.properties?.id;
      const text = textOf(node).replace(/\s+/g, " ").trim();
      if (typeof id === "string" && id !== "" && text !== "") entries.push({ id, text, depth });
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return entries;
}

const element = (
  tagName: string,
  properties: Record<string, unknown>,
  children: HastNode[],
): HastNode => ({ type: "element", tagName, properties, children });

/** The `nav` the plugin puts first into the rendered body. */
export function tocNavigation(entries: readonly TocEntry[], label: string): HastNode {
  return element(
    "nav",
    {
      ariaLabel: label,
      className: ["not-prose", "mb-8", "rounded-lg", "border", "bg-muted/40", "p-4", "text-sm"],
    },
    [
      element(
        "ol",
        { className: ["space-y-1"] },
        entries.map((entry) =>
          element("li", { className: entry.depth === 3 ? ["ml-4"] : [] }, [
            element(
              "a",
              {
                href: `#${entry.id}`,
                className: ["text-muted-foreground", "transition-colors", "hover:text-foreground"],
              },
              [{ type: "text", value: entry.text }],
            ),
          ]),
        ),
      ),
    ],
  );
}

export interface WikiTocOptions {
  /** The accessible name of the list (the page title: no new message key). */
  label: string;
  minEntries?: number;
}

/**
 * A rehype plugin for react-markdown: after rehype-slug (list it later),
 * puts a linked list of the h2/h3 headings in front of the body when there
 * are at least TOC_MIN_ENTRIES of them. Use it only when the page's
 * `tocEnabled` is not false.
 */
export function rehypeWikiToc(options: WikiTocOptions) {
  return (tree: HastNode): void => {
    const entries = collectTocEntries(tree);
    if (entries.length < (options.minEntries ?? TOC_MIN_ENTRIES)) return;
    tree.children = [tocNavigation(entries, options.label), ...(tree.children ?? [])];
  };
}

/** Whether a page shows its table of contents: on unless switched off. */
export const showsToc = (tocEnabled: boolean | null | undefined): boolean => tocEnabled !== false;
