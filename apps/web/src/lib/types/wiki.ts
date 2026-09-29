/** Wiki spaces and pages (WD01, split from lib/types.ts). */
import type { UserLite } from "./common";

export interface WikiSpace {
  id: number;
  documentId?: string;
  name: string;
  slug: string;
  description?: string | null;
  /**
   * A name from the icon map (components/icon-map.ts, the names quick
   * links use), in any letter case and with or without separators; the
   * schema default "book" is BookOpen; anything else renders the BookOpen
   * default (DA02, lib/wiki-content.ts wikiSpaceIconName).
   */
  icon?: string | null;
  visibility?: "public" | "role" | "department" | "team";
  pages?: WikiPage[];
}

export interface WikiPage {
  id: number;
  documentId?: string;
  title: string;
  slug: string;
  summary?: string | null;
  body?: string | null;
  /** Position in the space's page list, ascending; ties by title (DA02). */
  order?: number | null;
  /** Show the table of contents above the body; unset counts as on (the schema default). */
  tocEnabled?: boolean | null;
  /**
   * The `json` tags attribute. Authors in the web write a list of short
   * strings (the cms write allowlist), the admin panel any JSON, so read it
   * through `wikiTags()` (lib/wiki-content.ts) only.
   */
  tags?: unknown;
  updatedAt?: string;
  author?: UserLite | null;
  lastEditor?: UserLite | null;
  space?: WikiSpace | null;
}
