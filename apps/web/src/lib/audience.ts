/**
 * Announcement targeting rules for the web app, from @sinnlos/domain (SH01,
 * packages/domain/src/audience.ts): the same predicate the cms
 * `announcement-visibility` policy enforces.
 *
 * Reading an announcement is gated in the CMS by that policy, so pages never
 * need to filter; but the acknowledgement report has to answer the inverse
 * question ("WHO is targeted by this announcement?") and runs as admin_role,
 * which bypasses the policy. It therefore recomputes the target audience
 * with isAnnouncementVisibleTo.
 *
 * Deliberately NO admin/editor bypass: that bypass is a read permission
 * ("may see everything"), not audience membership. The report asks who the
 * announcement is FOR, so an editor from another department is not counted
 * toward a department-scoped announcement. The cms applies its bypass
 * before it asks the predicate; the predicate itself has none.
 */
export {
  isAnnouncementTargetedTo as isAnnouncementVisibleTo,
  teamIdsByUser,
  type AnnouncementTargeting as AnnouncementAudience,
  type AudienceScope,
  type TeamMembership,
} from "@sinnlos/domain";
