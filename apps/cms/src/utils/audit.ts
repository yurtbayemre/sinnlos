/**
 * The content activity trail (decision 06 §H; batch 15 plan item 7): the
 * vocabulary of `api::audit-event.audit-event` (contract K4). The recorder
 * (the last content middleware) and the append-only marker live here.
 *
 * One row per Document Service change of an audited document
 * (utils/authoring-uids.ts AUDITED_UIDS), written inside the change's
 * transaction: `action`, `targetUid`/`targetDocumentId`, the `revision` the
 * change produced, the actor (`actorKind`, `actorUserId` or `actorAdminId`,
 * `actorClass` from the authoring scope), the `source`, the changed
 * attribute names (`keys`, never values) and a `detail`.
 */

export const AUDIT_EVENT_UID = "api::audit-event.audit-event";

export const AUDIT_ACTIONS = [
  "create",
  "update",
  "delete",
  "clone",
  "publish",
  "unpublish",
  "discardDraft",
  "restore",
  "schedulePublish",
  "scheduleUnpublish",
  "scheduleFailed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ACTOR_KINDS = ["user", "admin", "system"] as const;

export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/** `system`: boot writers (seed, draft twins) outside any request (S12). */
export const AUDIT_SOURCES = ["content-api", "admin", "cron", "system"] as const;

/** Days an audit row is kept (`AUDIT_RETENTION_DAYS`, default). */
export const DEFAULT_AUDIT_RETENTION_DAYS = 365;
