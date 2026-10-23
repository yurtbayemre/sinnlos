import { AsyncLocalStorage } from "node:async_hooks";

import { isAuditedUid } from "./authoring-uids";
import {
  MUTATING_ACTIONS,
  getAuthoringScope,
  lockedActionOf,
  type AuditSource,
  type AuthoringScope,
} from "./document-lock";
import { scheduleClearAddedKeys } from "./schedule";

/**
 * The content activity trail (decision 06 §H; batch 15 plan item 7;
 * contract K4 for the vocabulary).
 *
 * THE ROW. One `api::audit-event.audit-event` row per Document Service
 * change of an audited document (utils/authoring-uids.ts AUDITED_UIDS, the
 * guarded set): `action`, `targetUid`/`targetDocumentId`, the `revision` the
 * change produced (from the document lock), the actor (`actorKind`,
 * `actorUserId` or `actorAdminId`, `actorClass`), the `source`, the
 * attribute names the write carried (`keys`: names only, never values; a
 * Content Manager save sends its whole form, so it lists every field) and
 * a `detail` (`cloned from <documentId>`, a schedule error code).
 *
 * THE RECORDER (`createAuditRecorder`) is the last content middleware
 * (slot 8 of bootstrap/document-middlewares.ts). After the action resolved
 * it inserts its row(s) with `strapi.db.query` INSIDE the action's
 * transaction (the document lock opened it), like the wiki revision (the
 * Kurzliste row "Lifecycles und Transaktionen"). Nothing catches the
 * insert: a failing insert rolls the change back, so a committed change
 * always has its row (a caught statement error would abort a Postgres
 * transaction silently, utils/after-commit.ts). Mapping:
 *   - create/update with `status: 'published'` publish inside the action
 *     (C3): a `publish` row follows the `create`/`update` row;
 *   - clone: one `clone` row for the NEW document, `cloned from <source>`;
 *   - under the scheduler (scope source `cron`) publish and unpublish are
 *     recorded as `schedulePublish` and `scheduleUnpublish`; the scheduler
 *     writes its own `scheduleFailed` rows (recordAuditEvent);
 *   - an update or a create that wrote nothing (a missing document) records
 *     nothing; a refused write (400/403/412) never gets here.
 *
 * THE ACTOR, from the request context (`strapi.requestContext.get()`, as
 * bootstrap/restricted-relation-guard.ts reads it):
 *   - `state.auth.strategy.name` `users-permissions`: `user` with the
 *     intranet user's id, source `content-api`;
 *   - `admin`: `admin` with the admin user's id (the admin strategy puts the
 *     admin user on `ctx.state.user`, C22), source `admin`;
 *   - another strategy (an API token, none): `system`, source `content-api`;
 *   - no request context: `system`, source `system` (boot writers: the demo
 *     seed, the draft-twin repair; S12), or the scope's `cron` under the
 *     scheduler.
 * `actorClass` is the authoring scope's `roleClass` (15A's gate), null for
 * panel, scheduler and boot writes. A scope's `source` overrides the
 * derived one.
 *
 * APPEND-ONLY. api/audit-event/content-types/audit-event/lifecycles.ts
 * refuses every create, update and delete (all six `before*` hooks, C33)
 * unless `auditWriteMode()` says the recorder (`writer`, creates only) or
 * the retention janitor (`janitor`, deletes only) is running. The Content
 * Manager can list and read the rows; its edits fail. A database superuser
 * can still change rows: an application trail, not tamper-evident storage.
 *
 * NOT COVERED: raw `strapi.db.query` writes (except the scheduler's, which
 * write their own rows), user and role changes, refused attempts.
 */

export const AUDIT_EVENT_UID = "api::audit-event.audit-event";

export const AUDIT_LOG = "[audit]";

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
  // v0.28: a user's export and anonymisation (utils/user-export.ts, utils/anonymise.ts).
  "export",
  "anonymise",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ACTOR_KINDS = ["user", "admin", "system"] as const;

export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/** `system`: boot writers (seed, draft twins) outside any request (S12). */
export const AUDIT_SOURCES = ["content-api", "admin", "cron", "system"] as const;

/** Days an audit row is kept (`AUDIT_RETENTION_DAYS`, default). */
export const DEFAULT_AUDIT_RETENTION_DAYS = 365;

/** Characters a string column holds (Postgres varchar(255)). */
const STRING_COLUMN_LENGTH = 255;

// ---------------------------------------------------------------------------
// The append-only marker.

export type AuditWriteMode = "writer" | "janitor";

const writeMode = new AsyncLocalStorage<AuditWriteMode>();

/** Who is writing audit rows right now (the lifecycle's question). */
export function auditWriteMode(): AuditWriteMode | undefined {
  return writeMode.getStore();
}

/** Runs `fn` as the retention janitor (the only deleter of audit rows). */
export function runAsAuditJanitor<T>(fn: () => T): T {
  return writeMode.run("janitor", fn);
}

// ---------------------------------------------------------------------------
// Rows.

/** One audit row as the recorder and the scheduler write it. */
export interface AuditEventInput {
  action: AuditAction;
  targetUid: string;
  targetDocumentId: string;
  revision?: number | null;
  actorKind: AuditActorKind;
  actorUserId?: number | null;
  actorAdminId?: number | null;
  actorClass?: string | null;
  source: AuditSource;
  keys?: string[] | null;
  detail?: string | null;
}

/** The slice of the Strapi instance the trail uses. */
export interface AuditHost {
  db: {
    query(uid: string): { create(params: { data: Record<string, unknown> }): Promise<unknown> };
  };
  requestContext?: { get(): unknown } | null;
}

/** At most `max` code points (never half a surrogate pair). */
export function clip(value: string | null | undefined, max = STRING_COLUMN_LENGTH): string | null {
  if (value === null || value === undefined) return null;
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
}

/**
 * Inserts one audit row (as the writer, so the append-only lifecycle lets
 * it through). Inside a transaction it joins it; nothing here catches.
 */
export async function recordAuditEvent(strapi: AuditHost, row: AuditEventInput): Promise<void> {
  await writeMode.run("writer", () =>
    strapi.db.query(AUDIT_EVENT_UID).create({
      data: {
        action: row.action,
        targetUid: row.targetUid,
        targetDocumentId: row.targetDocumentId,
        revision: row.revision ?? null,
        actorKind: row.actorKind,
        actorUserId: row.actorUserId ?? null,
        actorAdminId: row.actorAdminId ?? null,
        actorClass: clip(row.actorClass),
        source: row.source,
        keys: row.keys ?? null,
        detail: clip(row.detail),
        publishedAt: new Date(),
      },
    }),
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numericId = (value: unknown): number | null => {
  const id = isRecord(value) ? value.id : undefined;
  return typeof id === "number" && Number.isInteger(id) ? id : null;
};

/** Who is acting (see the module comment). */
export interface AuditActor {
  actorKind: AuditActorKind;
  actorUserId: number | null;
  actorAdminId: number | null;
  actorClass: string | null;
  source: AuditSource;
}

export function resolveActor(
  strapi: Pick<AuditHost, "requestContext">,
  scope: AuthoringScope | undefined,
): AuditActor {
  const ctx = strapi.requestContext?.get?.();
  const actorClass = scope?.roleClass ?? null;
  const base = { actorUserId: null, actorAdminId: null, actorClass };
  if (!isRecord(ctx)) {
    return { ...base, actorKind: "system", source: scope?.source ?? "system" };
  }
  const state = isRecord(ctx.state) ? ctx.state : {};
  const auth = isRecord(state.auth) ? state.auth : {};
  const strategy = isRecord(auth.strategy) ? auth.strategy.name : undefined;
  if (strategy === "admin") {
    return {
      ...base,
      actorKind: "admin",
      actorAdminId: numericId(state.user),
      source: scope?.source ?? "admin",
    };
  }
  if (strategy === "users-permissions") {
    return {
      ...base,
      actorKind: "user",
      actorUserId: numericId(state.user),
      source: scope?.source ?? "content-api",
    };
  }
  return { ...base, actorKind: "system", source: scope?.source ?? "content-api" };
}

/** Attributes a write cannot "change" in the trail's sense (Strapi bookkeeping). */
const BOOKKEEPING_KEYS: ReadonlySet<string> = new Set([
  "id",
  "documentId",
  "createdAt",
  "updatedAt",
  "publishedAt",
  "createdBy",
  "updatedBy",
  "locale",
  "localizations",
]);

/** The attribute names a write's data carries, sorted; never values. */
export function changedKeys(
  data: unknown,
  attributes: Record<string, unknown> | undefined,
): string[] | null {
  if (!isRecord(data)) return null;
  const keys = Object.keys(data).filter(
    (key) => !BOOKKEEPING_KEYS.has(key) && (!attributes || key in attributes),
  );
  return keys.sort();
}

interface AuditContext {
  uid?: string;
  action?: string;
  params?: unknown;
  contentType?: { attributes?: Record<string, unknown> };
}

const documentIdOf = (value: unknown): string | null =>
  isRecord(value) && typeof value.documentId === "string" && value.documentId !== ""
    ? value.documentId
    : null;

/** The audit rows one finished action produces (without the actor). */
export function auditRowsFor(
  context: AuditContext,
  result: unknown,
  revision: number | null,
  cron: boolean,
): Array<Pick<AuditEventInput, "action" | "targetDocumentId" | "keys" | "detail" | "revision">> {
  const action = context.action ?? "";
  const params = isRecord(context.params) ? context.params : {};
  // What the writer sent: the schedule fields schedule-clear added are no change of theirs.
  const added = scheduleClearAddedKeys(context);
  const keys = () =>
    changedKeys(params.data, context.contentType?.attributes)?.filter(
      (key) => !added.includes(key),
    ) ?? null;
  const publishedToo = params.status === "published";
  switch (action) {
    case "create":
    case "update": {
      const documentId =
        documentIdOf(result) ?? (action === "update" ? documentIdOf(params) : null);
      if (documentId === null || result === null || result === undefined) return [];
      const rows: ReturnType<typeof auditRowsFor> = [
        { action, targetDocumentId: documentId, keys: keys(), detail: null, revision },
      ];
      if (publishedToo) {
        rows.push({
          action: "publish",
          targetDocumentId: documentId,
          keys: null,
          detail: null,
          revision,
        });
      }
      return rows;
    }
    case "clone": {
      const documentId = documentIdOf(result);
      if (documentId === null) return [];
      const source = documentIdOf(params);
      return [
        {
          action: "clone",
          targetDocumentId: documentId,
          keys: keys(),
          detail: source ? `cloned from ${source}` : null,
          revision,
        },
      ];
    }
    case "publish":
    case "unpublish":
    case "discardDraft":
    case "delete": {
      const documentId = documentIdOf(params);
      if (documentId === null) return [];
      const mapped: AuditAction =
        cron && action === "publish"
          ? "schedulePublish"
          : cron && action === "unpublish"
            ? "scheduleUnpublish"
            : action;
      return [{ action: mapped, targetDocumentId: documentId, keys: null, detail: null, revision }];
    }
    default:
      return [];
  }
}

/** The audit recorder middleware (see the module comment). */
export function createAuditRecorder(strapi: AuditHost) {
  return async (context: AuditContext, next: () => Promise<unknown>): Promise<unknown> => {
    const uid = context.uid;
    if (!isAuditedUid(uid) || !MUTATING_ACTIONS.includes(context.action ?? "")) return next();
    const result = await next();
    const scope = getAuthoringScope();
    const actor = resolveActor(strapi, scope);
    const revision = lockedActionOf(context)?.revision ?? null;
    for (const row of auditRowsFor(context, result, revision, actor.source === "cron")) {
      await recordAuditEvent(strapi, { ...row, ...actor, targetUid: uid });
    }
    return result;
  };
}
