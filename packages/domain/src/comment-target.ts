/**
 * Target anchoring for comments and reactions: "which announcement / wiki
 * page does this row belong to?" (GitHub issue #11). The pure part, shared by
 * the cms (apps/cms/src/utils/comment-target.ts re-exports it next to its
 * database lookups) and the web (apps/web/src/lib/comment-target.ts).
 *
 * `comment` and `reaction` are polymorph (`targetType` enum + target key, no
 * FK) and used to anchor their target by its NUMERIC row id (`targetId`).
 * Both target types, announcement and wiki-page, are draftAndPublish, and
 * Strapi 5 publishes by DELETE-then-RECREATE: the published row gets a NEW
 * numeric id on every publish, so every discussion silently orphaned on the
 * next "Publish". The `documentId` is stable across the entire draft/publish
 * lifecycle, so the anchor is `targetType` + `targetDocumentId` (string),
 * the anchor acknowledgements, RSVPs and notifications use too
 * (docs/architecture.md §5.17 / §5.26). The anchor is the ONLY target key:
 * the legacy numeric `targetId` handling was removed with #25.
 */

/** The polymorph targets a comment/reaction can point at, both draftAndPublish. */
export const COMMENT_TARGET_TYPES = ["announcement", "wiki-page"] as const;

export type CommentTargetType = (typeof COMMENT_TARGET_TYPES)[number];

/**
 * Exactly one of COMMENT_TARGET_TYPES. An array lookup, never `value in
 * <object>` (FX27): that also found inherited keys such as "constructor" or
 * "__proto__", which then failed later with a 500.
 */
export function isCommentTargetType(value: unknown): value is CommentTargetType {
  return typeof value === "string" && (COMMENT_TARGET_TYPES as readonly string[]).includes(value);
}

/**
 * Normalise a documentId to a usable anchor. Anything that is not a
 * non-empty string (null, number, whitespace) means "no anchor": a blank
 * value is never a valid key, it would match unrelated rows.
 */
export function targetAnchor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The anchor of a looked-up target row, or `null` when the target is gone
 * (deleted, or its published row was replaced long ago). `null` means SKIP,
 * never "invent an id".
 */
export function anchorFromTargetRow(
  target: { documentId?: unknown } | null | undefined,
): string | null {
  return targetAnchor(target?.documentId);
}

/**
 * `where` clause (Strapi db.query) matching every comment/reaction of one
 * target: the anchor pair only. A row with `targetDocumentId IS NULL` never
 * matches.
 */
export function targetMatchWhere(
  targetType: CommentTargetType,
  targetDocumentId: string,
): Record<string, unknown> {
  return { targetType, targetDocumentId };
}

/** The entry a comment section / reaction bar belongs to (web). */
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

/**
 * Strapi REST `filters[…]` fragment selecting every row of one target.
 * `null` means the target cannot be addressed at all: the caller renders an
 * empty section instead of firing a query that would match everything.
 */
export function targetFilterQuery(target: CommentTarget): string | null {
  const anchor = targetAnchor(target.documentId);
  if (anchor == null) return null;

  return [
    `filters[targetType][$eq]=${encodeURIComponent(target.type)}`,
    `filters[targetDocumentId][$eq]=${encodeURIComponent(anchor)}`,
  ].join("&");
}

/**
 * Does this row belong to the target? Applied to the fetched rows as well:
 * permanent defense in depth, so a mis-built filter can never mix a foreign
 * discussion into a section or a reaction count. A row without an anchor
 * never matches.
 */
export function matchesTarget(row: TargetedRow, target: CommentTarget): boolean {
  if (row.targetType !== target.type) return false;

  const rowAnchor = targetAnchor(row.targetDocumentId);
  if (rowAnchor == null) return false;

  const anchor = targetAnchor(target.documentId);
  return anchor != null && rowAnchor === anchor;
}
