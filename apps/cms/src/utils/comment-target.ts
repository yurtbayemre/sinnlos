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
 * `targetId` stays in the schema, deprecated — but it is still WRITTEN for
 * the transition period (`resolveWriteTarget`, "dual-write"): every new row
 * gets the anchor AND the target's current row id. Two reasons, both about
 * rollback (see `infra/deploy.sh`):
 *   - a FULL rollback to the id-only code filters on `targetId` alone, so
 *     rows written in the meantime would be invisible without it,
 *   - the bootstrap backfill (`src/index.ts`) has no other bridge for rows
 *     written before the anchor existed.
 *
 * TEMPORARY MIGRATION BRIDGE. The follow-up ticket to #11 ("remove the
 * deprecated targetId column", planned a few weeks after this deploy) drops
 * the column, the dual-write, the `targetId` acceptance in `resolveWriteTarget`
 * and every legacy branch in this file at once — see docs/architecture.md
 * §5.27.
 *
 * Pure decision logic, no Strapi runtime, so the migration and the anchor
 * resolution are unit testable (`comment-target.test.ts`); the runtime
 * helpers at the bottom are thin wrappers over `strapi.db.query`, following
 * the `notification-source.ts` pattern.
 */

/** The polymorph targets a comment/reaction can point at. */
export type CommentTargetType = "announcement" | "wiki-page";

/** targetType → content-type uid. Both targets are draftAndPublish. */
export const TARGET_UIDS: Record<CommentTargetType, string> = {
  announcement: "api::announcement.announcement",
  "wiki-page": "api::wiki-page.wiki-page",
};

/** The collections whose rows carry a (targetType, targetDocumentId) anchor. */
export const ANCHORED_UIDS = ["api::comment.comment", "api::reaction.reaction"] as const;

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

/**
 * Normalise the deprecated numeric anchor. Accepts the integer the DB
 * returns and the numeric string an API caller may send; rejects 0, negative
 * values and non-integers (no valid row id).
 */
export function legacyTargetId(value: unknown): number | null {
  const num = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof num !== "number" || !Number.isInteger(num) || num <= 0) return null;
  return num;
}

/** Whatever the backfill reads: a comment or reaction row. */
export interface AnchorableRow {
  id?: number | string | null;
  targetType?: string | null;
  targetDocumentId?: string | null;
  targetId?: number | string | null;
}

export type BackfillPlan =
  /** Nothing to do — the row already carries an anchor. */
  | { action: "skip"; reason: "already-anchored" }
  /** targetType is not one of the known targets — cannot resolve a uid. */
  | { action: "skip"; reason: "unknown-target-type" }
  /** No anchor AND no usable legacy id — nothing left to resolve from. */
  | { action: "skip"; reason: "no-legacy-id" }
  /** Look the target row up by its numeric id and copy its documentId. */
  | { action: "resolve"; uid: string; legacyTargetId: number };

/**
 * Decide what the backfill has to do with ONE row.
 *
 * Idempotent by construction: a row that already has an anchor is skipped,
 * so the bootstrap can run this on every start and does real work only once.
 * A row that cannot be resolved is skipped too — the caller must never guess
 * an anchor, a wrong one would move the comment to a foreign announcement.
 */
export function planAnchorBackfill(row: AnchorableRow | null | undefined): BackfillPlan {
  if (targetAnchor(row?.targetDocumentId) != null) {
    return { action: "skip", reason: "already-anchored" };
  }
  const uid = targetUid(row?.targetType);
  if (uid == null) return { action: "skip", reason: "unknown-target-type" };

  const legacy = legacyTargetId(row?.targetId);
  if (legacy == null) return { action: "skip", reason: "no-legacy-id" };

  return { action: "resolve", uid, legacyTargetId: legacy };
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
 * `where` clause matching every comment/reaction of one target.
 *
 * The second branch is TEMPORARY (issue #11): rows the bootstrap backfill has
 * not anchored yet are matched by their deprecated numeric id. It is guarded
 * by `targetDocumentId IS NULL` on purpose, and that guard is what makes the
 * dual-write (`resolveWriteTarget`) safe: a row that carries BOTH keys is
 * matched by the first branch only, never twice, and an ANCHORED row of a
 * different target cannot sneak in via the second branch once a re-publish
 * hands its old numeric id to another row. Drop the branch (and the `legacy`
 * argument) with the column.
 */
export function targetMatchWhere(
  targetType: CommentTargetType,
  targetDocumentId: string,
  legacy?: number | string | null,
): Record<string, unknown> {
  const legacyId = legacyTargetId(legacy);
  if (legacyId == null) return { targetType, targetDocumentId };
  return {
    targetType,
    $or: [
      { targetDocumentId },
      // Object with two keys = implicit AND: unanchored AND that row id.
      { targetDocumentId: { $null: true }, targetId: legacyId },
    ],
  };
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
 * An anchored row NEVER falls back to `targetId`: if the documentId resolves
 * to nothing the target is gone, and the stale numeric id may meanwhile
 * belong to a completely different entry.
 *
 * The `targetId` path is the TEMPORARY bridge (issue #11) for rows the
 * bootstrap backfill could not anchor yet.
 */
export async function findCommentTarget(
  strapiInstance: TargetLookupStrapi,
  row: AnchorableRow | null | undefined,
  options: Record<string, unknown> = {},
): Promise<any | null> {
  const uid = targetUid(row?.targetType);
  if (uid == null) return null;

  const anchor = targetAnchor(row?.targetDocumentId);
  if (anchor != null) {
    const published = await strapiInstance.db
      .query(uid)
      .findOne({ ...options, where: { documentId: anchor, publishedAt: { $notNull: true } } });
    if (published) return published;
    return (
      (await strapiInstance.db.query(uid).findOne({ ...options, where: { documentId: anchor } })) ??
      null
    );
  }

  const legacy = legacyTargetId(row?.targetId);
  if (legacy == null) return null;
  return (
    (await strapiInstance.db.query(uid).findOne({ ...options, where: { id: legacy } })) ?? null
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
      /**
       * DEPRECATED dual-write value: the target's CURRENT row id, published
       * row preferred. `null` only if the resolved row has no usable id.
       */
      targetId: number | null;
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
 * two anchor columns to store.
 *
 * The anchor is `targetDocumentId`; the numeric `targetId` is written
 * alongside it (dual-write) so a rollback to the id-only code still finds
 * these rows. It is the target's CURRENT row id — published row preferred,
 * exactly what `findCommentTarget` resolves — and it can NOT be matched twice
 * by the legacy read branch, which is clamped to `targetDocumentId IS NULL`
 * (`targetMatchWhere`).
 *
 * WRITE BRIDGE, TEMPORARY (issue #11): a caller that only sends the
 * deprecated `targetId` — an OLD web container against a NEW CMS, i.e. the
 * partial rollback documented in `infra/deploy.sh` — is not rejected; the
 * target is looked up by row id and ITS documentId becomes the anchor. So a
 * half-rolled-back deployment keeps writing correctly anchored rows instead
 * of failing every comment and every reaction with a 400.
 *
 * A write is rejected only when the targetType is unknown, when NEITHER key
 * is usable, or when the target cannot be resolved at all (which also stops
 * the unanchored orphan rows the previous version happily created for a
 * bogus documentId).
 *
 * Remove the `targetId` acceptance, the `targetId` in the result and this
 * whole paragraph together with the column (follow-up ticket to #11).
 */
export async function resolveWriteTarget(
  strapiInstance: TargetLookupStrapi,
  input: AnchorableRow | null | undefined,
): Promise<WriteTargetResolution> {
  const targetType = input?.targetType;
  if (!isCommentTargetType(targetType))
    return { status: "rejected", reason: "invalid-target-type" };

  const anchor = targetAnchor(input?.targetDocumentId);
  const legacy = legacyTargetId(input?.targetId);
  if (anchor == null && legacy == null) return { status: "rejected", reason: "missing-target" };

  // Anchor wins whenever it is present: `findCommentTarget` ignores the
  // numeric id then, so a stale/foreign targetId in the payload cannot
  // redirect the write.
  const target = await findCommentTarget(strapiInstance, {
    targetType,
    targetDocumentId: anchor,
    targetId: legacy,
  });
  const resolvedAnchor = anchorFromTargetRow(target);
  if (resolvedAnchor == null) return { status: "rejected", reason: "unresolved-target" };

  // Anchored path: `target` already IS the published-preferred row. Only the
  // bridge path may have landed on a draft row (it looked up one exact id),
  // so re-resolve there — the dual-written id must be the one the rolled-back
  // code filters on, and that code reads published rows.
  const canonical =
    anchor != null
      ? target
      : ((await findCommentTarget(strapiInstance, {
          targetType,
          targetDocumentId: resolvedAnchor,
        })) ?? target);

  return {
    status: "ok",
    targetType,
    targetDocumentId: resolvedAnchor,
    targetId: legacyTargetId(canonical?.id),
  };
}
