/**
 * Addressing the target of a comment/reaction section — the web mirror of
 * `apps/cms/src/utils/comment-target.ts` (issue #11).
 *
 * Comments and reactions are polymorph (`targetType` + target key, no FK) and
 * used to reference their announcement / wiki page by NUMERIC row id. Both
 * target types are draftAndPublish and Strapi 5 publishes by DELETE-then-
 * RECREATE, so that id changes with every publish and the whole discussion
 * detached. The anchor is the `documentId`, which is stable across the entire
 * draft/publish lifecycle — the same anchor acknowledgements, RSVPs and
 * notifications already use (docs/architecture.md §5.17).
 *
 * The anchor is the ONLY target key — the legacy numeric `targetId` handling
 * was removed together with the CMS migration bridge (#25).
 *
 * Pure string/predicate logic, no fetching — unit tested in
 * `comment-target.test.ts`.
 */

export type CommentTargetType = "announcement" | "wiki-page";

/** The entry a comment section / reaction bar belongs to. */
export interface CommentTarget {
  type: CommentTargetType;
  /** Stable anchor. Every Strapi 5 row has one; writes require it. */
  documentId?: string | null;
}

/** One comment/reaction row, as far as target matching cares. */
export interface TargetedRow {
  targetType?: string | null;
  targetDocumentId?: string | null;
}

/** Normalise a documentId; blank/non-string means "no anchor". */
export function anchorOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Strapi REST `filters[…]` fragment selecting every row of one target.
 * `null` means the target cannot be addressed at all — the caller renders an
 * empty section instead of firing a query that would match everything.
 */
export function targetFilterQuery(target: CommentTarget): string | null {
  const anchor = anchorOf(target.documentId);
  if (anchor == null) return null;

  return [
    `filters[targetType][$eq]=${encodeURIComponent(target.type)}`,
    `filters[targetDocumentId][$eq]=${encodeURIComponent(anchor)}`,
  ].join("&");
}

/**
 * Does this row belong to the target? Applied to the fetched rows as well —
 * permanent defense-in-depth: a mis-built filter can never mix a foreign
 * discussion into a section or a reaction count.
 *
 * A row without an anchor never matches (the legacy targetId branch was
 * removed with #25).
 */
export function matchesTarget(row: TargetedRow, target: CommentTarget): boolean {
  if (row.targetType !== target.type) return false;

  const rowAnchor = anchorOf(row.targetDocumentId);
  if (rowAnchor == null) return false;

  const anchor = anchorOf(target.documentId);
  return anchor != null && rowAnchor === anchor;
}
