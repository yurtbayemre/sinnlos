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
 * The `id` on `CommentTarget` is TEMPORARY: it exists only to still find rows
 * the CMS bootstrap backfill has not anchored yet. Writes from here never use
 * it — the CMS derives the deprecated `targetId` itself and dual-writes it as
 * a rollback anchor (issue #11), which the guard in the legacy branch below
 * keeps invisible to this read path.
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
  /**
   * DEPRECATED numeric row id (issue #11). Read-only bridge for rows the CMS
   * backfill could not anchor yet — remove together with the CMS column.
   */
  id?: number | null;
}

/** One comment/reaction row, as far as target matching cares. */
export interface TargetedRow {
  targetType?: string | null;
  targetDocumentId?: string | null;
  targetId?: number | null;
}

/** Normalise a documentId; blank/non-string means "no anchor". */
export function anchorOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Normalise the deprecated numeric anchor (positive integers only). */
export function legacyIdOf(value: unknown): number | null {
  const num = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof num !== "number" || !Number.isInteger(num) || num <= 0) return null;
  return num;
}

/**
 * Strapi REST `filters[…]` fragment selecting every row of one target.
 * `null` means the target cannot be addressed at all — the caller renders an
 * empty section instead of firing a query that would match everything.
 *
 * The legacy branch is TEMPORARY (issue #11) and guarded by
 * `targetDocumentId IS NULL`: without that guard an ANCHORED row of another
 * entry would match as soon as a re-publish handed its old numeric id to a
 * different row.
 *
 * Both legacy conditions sit in the SAME `$or` element on purpose — an object
 * with two keys is an implicit AND, and it keeps the query within the depth
 * limit of Strapi's `qs` parser (default depth 5). The explicit nesting
 * `filters[$or][1][$and][0][targetDocumentId][$null]` is one level too deep:
 * qs stops parsing there and hands Strapi the literal key "[$null]", which
 * `validateQuery` rejects with 400 (verified against @strapi/utils 5.49).
 */
export function targetFilterQuery(target: CommentTarget): string | null {
  const anchor = anchorOf(target.documentId);
  const legacy = legacyIdOf(target.id);
  if (anchor == null && legacy == null) return null;

  const parts = [`filters[targetType][$eq]=${encodeURIComponent(target.type)}`];
  if (anchor != null && legacy != null) {
    parts.push(`filters[$or][0][targetDocumentId][$eq]=${encodeURIComponent(anchor)}`);
    parts.push("filters[$or][1][targetDocumentId][$null]=true");
    parts.push(`filters[$or][1][targetId][$eq]=${legacy}`);
  } else if (anchor != null) {
    parts.push(`filters[targetDocumentId][$eq]=${encodeURIComponent(anchor)}`);
  } else {
    parts.push("filters[targetDocumentId][$null]=true");
    parts.push(`filters[targetId][$eq]=${legacy}`);
  }
  return parts.join("&");
}

/**
 * Does this row belong to the target? Applied to the fetched rows as well,
 * so a mis-built filter (or a future change to the temporary legacy branch)
 * can never mix a foreign discussion into a section or a reaction count.
 *
 * An ANCHORED row is matched by its anchor only: its numeric targetId may be
 * stale, and after a re-publish that id can belong to a different entry.
 */
export function matchesTarget(row: TargetedRow, target: CommentTarget): boolean {
  if (row.targetType !== target.type) return false;

  const rowAnchor = anchorOf(row.targetDocumentId);
  if (rowAnchor != null) {
    const anchor = anchorOf(target.documentId);
    return anchor != null && rowAnchor === anchor;
  }

  // TEMPORARY (issue #11): row written before the anchor existed.
  const rowLegacy = legacyIdOf(row.targetId);
  const legacy = legacyIdOf(target.id);
  return rowLegacy != null && legacy != null && rowLegacy === legacy;
}
