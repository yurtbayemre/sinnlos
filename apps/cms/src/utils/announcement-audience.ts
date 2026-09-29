/**
 * Announcement targeting rules: "may this user see this announcement" as far
 * as its audience goes. The rules live in @sinnlos/domain (SH01,
 * packages/domain/src/audience.ts), shared with the web's acknowledgement
 * report; this module keeps the cms import path and name.
 *
 * The `announcement-visibility` policy resolves the caller's scope and the
 * announcement rows from the DB and then asks isAnnouncementVisible, so the
 * decision itself stays unit testable without a running Strapi. The
 * admin_role/editor read bypass is not decided here: callers check
 * `hasRole(user, MODERATORS)` from bootstrap/roles.ts first, as the other
 * visibility policies do (the announcement-visibility policy, the
 * acknowledgement controller).
 */
export {
  isAnnouncementTargetedTo as isAnnouncementVisible,
  type AnnouncementTargeting,
  type AudienceScope,
} from "@sinnlos/domain";
