/**
 * Target anchoring for comments and reactions: "which announcement / wiki
 * page does this row belong to?" (GitHub issue #11).
 *
 * The pure anchor rules (the target types, anchor normalisation, the anchor
 * `where`) live in @sinnlos/domain (SH01, packages/domain/src/
 * comment-target.ts), shared with the web; this module re-exports them and
 * keeps what needs Strapi: the content-type uids and the database lookups.
 *
 * Both target types are draftAndPublish and Strapi 5 publishes by
 * DELETE-then-RECREATE, so the anchor is `targetType` + `targetDocumentId`
 * (the documentId is stable across the whole draft/publish lifecycle), never
 * the numeric row id (docs/architecture.md §5.17 / §5.26). The migration
 * bridge (deprecated `targetId` attribute, dual-write, write bridge, legacy
 * read branches, bootstrap backfill) was removed with the follow-up ticket
 * #25. The DB column `target_id` still exists but is orphaned: Strapi's
 * schema sync would drop it on boot by default, so `config/database.ts` sets
 * `settings.forceMigration: false` to keep it as the rollback anchor. See
 * docs/architecture.md §5.27 for the deliberate drop later.
 *
 * The runtime helpers at the bottom are thin wrappers over `strapi.db.query`,
 * following the `notification-source.ts` pattern (`comment-target.test.ts`).
 */
import {
  anchorFromTargetRow,
  isCommentTargetType,
  targetAnchor,
  targetMatchWhere,
  type CommentTargetType,
} from "@sinnlos/domain";

export { anchorFromTargetRow, isCommentTargetType, targetAnchor, targetMatchWhere };
export type { CommentTargetType };

/** targetType → content-type uid. Both targets are draftAndPublish. */
export const TARGET_UIDS: Record<CommentTargetType, string> = {
  announcement: "api::announcement.announcement",
  "wiki-page": "api::wiki-page.wiki-page",
};

/** Content-type uid for a targetType, or `null` for an unknown value. */
export function targetUid(targetType: unknown): string | null {
  return isCommentTargetType(targetType) ? TARGET_UIDS[targetType] : null;
}

/** Input of the target resolution: the target keys of a comment/reaction. */
export interface AnchorableRow {
  id?: number | string | null;
  targetType?: string | null;
  targetDocumentId?: string | null;
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
