/**
 * Target anchoring for comments and reactions — the single source of truth
 * for "which announcement / wiki page does this row belong to?".
 *
 * Why this exists (GitHub issue #11): `comment` and `reaction` are polymorph
 * (`targetType` enum + target key, no FK) and used to anchor their target by
 * its NUMERIC row id (`targetId`). Both target types — announcement and
 * wiki-page — are draftAndPublish, and Strapi 5 publishes by DELETE-then-
 * RECREATE: the published row gets a NEW numeric id on every publish. So the
 * next time an editor hits "Publish", every comment and every reaction on
 * that entry pointed at a row id that no longer existed — the whole
 * discussion silently orphaned.
 *
 * The `documentId` is stable across the entire draft/publish lifecycle, so
 * the anchor is `targetType` + `targetDocumentId` (string) — exactly what
 * acknowledgement, event-rsvp and notification already do (docs/architecture
 * .md §5.17 / §5.26).
 *
 * The migration bridge (deprecated `targetId` attribute, dual-write, write
 * bridge, legacy read branches, bootstrap backfill) was removed with the
 * follow-up ticket #25. The anchor is the ONLY target key now; the DB column
 * `target_id` still exists but is orphaned — Strapi's schema sync would drop
 * it on boot by default, so `config/database.ts` sets
 * `settings.forceMigration: false` to keep it as the rollback anchor. See
 * docs/architecture.md §5.27 for the deliberate drop later.
 *
 * Pure decision logic, no Strapi runtime, so the anchor resolution is unit
 * testable (`comment-target.test.ts`); the runtime helpers at the bottom are
 * thin wrappers over `strapi.db.query`, following the
 * `notification-source.ts` pattern.
 */

/** The polymorph targets a comment/reaction can point at. */
export type CommentTargetType = "announcement" | "wiki-page";

/** targetType → content-type uid. Both targets are draftAndPublish. */
export const TARGET_UIDS: Record<CommentTargetType, string> = {
  announcement: "api::announcement.announcement",
  "wiki-page": "api::wiki-page.wiki-page",
};

export function isCommentTargetType(value: unknown): value is CommentTargetType {
  return typeof value === "string" && value in TARGET_UIDS;
}

/** Content-type uid for a targetType, or `null` for an unknown value. */
export function targetUid(targetType: unknown): string | null {
  return isCommentTargetType(targetType) ? TARGET_UIDS[targetType] : null;
}

/**
 * Normalise a documentId to a usable anchor. Anything that is not a
 * non-empty string (null, number, whitespace) means "no anchor" — never
 * treat a blank value as a valid key, it would match unrelated rows.
 */
export function targetAnchor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Input of the target resolution: the target keys of a comment/reaction. */
export interface AnchorableRow {
  id?: number | string | null;
  targetType?: string | null;
  targetDocumentId?: string | null;
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
 * `where` clause matching every comment/reaction of one target — the anchor
 * pair only. A row with `targetDocumentId IS NULL` never matches (the legacy
 * `targetId` read branch was removed with #25).
 */
export function targetMatchWhere(
  targetType: CommentTargetType,
  targetDocumentId: string,
): Record<string, unknown> {
  return { targetType, targetDocumentId };
}

/** Minimal slice of the Strapi instance the runtime helpers need. */
export interface TargetLookupStrapi {
  db: {
    query: (uid: string) => {
      findOne: (params: Record<string, unknown>) => Promise<any>;
    };
  };
}

/**
 * Load the entry a comment/reaction points at.
 *
 * Anchor first: both target types are draftAndPublish, so one documentId
 * matches a draft AND a published row — the published one is preferred
 * (that is what readers commented on), with the draft as fallback so a
 * target that is currently unpublished still resolves.
 *
 * The anchor is the ONLY key: a row without a usable `targetDocumentId`
 * resolves to `null`, and a stale numeric row id is NEVER looked up — after
 * a re-publish it may belong to a completely different entry (the legacy
 * bridge was removed with #25).
 */
export async function findCommentTarget(
  strapiInstance: TargetLookupStrapi,
  row: AnchorableRow | null | undefined,
  options: Record<string, unknown> = {},
): Promise<any | null> {
  const uid = targetUid(row?.targetType);
  if (uid == null) return null;

  const anchor = targetAnchor(row?.targetDocumentId);
  if (anchor == null) return null;

  const published = await strapiInstance.db
    .query(uid)
    .findOne({ ...options, where: { documentId: anchor, publishedAt: { $notNull: true } } });
  if (published) return published;
  return (
    (await strapiInstance.db.query(uid).findOne({ ...options, where: { documentId: anchor } })) ??
    null
  );
}

/** Why a write was rejected — mapped to a 400 by the controllers. */
export type WriteTargetError = "invalid-target-type" | "missing-target" | "unresolved-target";

/**
 * Discriminated by a STRING like `BackfillPlan` above, not by an `ok` boolean:
 * the CMS extends Strapi's tsconfig, which sets `strict: false`, and a boolean
 * discriminant does not narrow without strictNullChecks.
 */
export type WriteTargetResolution =
  | {
      status: "ok";
      targetType: CommentTargetType;
      /** The anchor to store. */
      targetDocumentId: string;
    }
  | { status: "rejected"; reason: WriteTargetError };

/** 400 message per reject reason, shared by the comment and reaction controller. */
export const WRITE_TARGET_ERRORS: Record<WriteTargetError, string> = {
  "invalid-target-type": "Invalid targetType",
  // Deliberately the SAME message for "no key at all" and "key resolves to
  // nothing": a distinct answer would turn create into an existence oracle
  // for documentIds the caller may not read (docs/architecture.md §5.17).
  "missing-target": "targetDocumentId required",
  "unresolved-target": "targetDocumentId required",
};

/**
 * Resolve the target of an incoming comment/reaction write and produce the
 * anchor to store.
 *
 * Only `targetType` + `targetDocumentId` are accepted — a payload carrying
 * nothing but the removed legacy `targetId` is rejected with `missing-target`
 * (400), and a `targetId` sent alongside a valid anchor is simply ignored:
 * `findCommentTarget` never looks a row id up, so a stale/foreign id cannot
 * redirect the write (#25 removed the write bridge and the dual-write).
 *
 * A write is rejected when the targetType is unknown, when the anchor is
 * missing/blank, or when it resolves to nothing (which also stops the
 * unanchored orphan rows the pre-#11 code happily created for a bogus
 * documentId).
 */
export async function resolveWriteTarget(
  strapiInstance: TargetLookupStrapi,
  input: AnchorableRow | null | undefined,
): Promise<WriteTargetResolution> {
  const targetType = input?.targetType;
  if (!isCommentTargetType(targetType))
    return { status: "rejected", reason: "invalid-target-type" };

  const anchor = targetAnchor(input?.targetDocumentId);
  if (anchor == null) return { status: "rejected", reason: "missing-target" };

  const target = await findCommentTarget(strapiInstance, {
    targetType,
    targetDocumentId: anchor,
  });
  const resolvedAnchor = anchorFromTargetRow(target);
  if (resolvedAnchor == null) return { status: "rejected", reason: "unresolved-target" };

  return {
    status: "ok",
    targetType,
    targetDocumentId: resolvedAnchor,
  };
}
