/**
 * Addressing the target of a comment/reaction section (issue #11), from
 * @sinnlos/domain (SH01, packages/domain/src/comment-target.ts): the same
 * anchor rules the cms applies (apps/cms/src/utils/comment-target.ts).
 *
 * Comments and reactions are polymorph (`targetType` + target key, no FK).
 * Both target types are draftAndPublish and Strapi 5 publishes by
 * DELETE-then-RECREATE, so the anchor is the `documentId`, stable across the
 * entire draft/publish lifecycle (docs/architecture.md §5.17); the legacy
 * numeric `targetId` handling was removed with #25.
 */
export {
  targetAnchor as anchorOf,
  matchesTarget,
  targetFilterQuery,
  type CommentTarget,
  type CommentTargetType,
  type TargetedRow,
} from "@sinnlos/domain";
