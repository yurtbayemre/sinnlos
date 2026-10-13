import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

import { isGuardedUid } from "./authoring-uids";

/**
 * The document revision and its lock (decision 06 §G, §G2; batch 15 plan,
 * contract K2).
 *
 * TOKEN. Every guarded document (utils/authoring-uids.ts GUARDED_UIDS) has
 * a revision: one row per document in `content_versions`
 * (`api::content-version.content-version`: targetUid, targetDocumentId,
 * revision), unique on (target_uid, target_document_id) through the index
 * bootstrap/document-indexes.ts creates at every boot. A document without
 * a row has revision 0; its first mutation creates the row. Reads never
 * write. The row goes with the document.
 *
 * WHY NOT updatedAt. Publish, unpublish and the scheduler's claim leave
 * the draft's `updatedAt` alone, and a discard restores an older one, so
 * an `If-Match` on it would miss exactly the transitions a form must see.
 *
 * THE LOCK. `createDocumentLock` is the second Document Service middleware
 * (bootstrap/document-middlewares.ts, after the offset-less datetime
 * guard). For every mutating action on a guarded uid (create, update,
 * clone, delete, publish, unpublish, discardDraft) it opens the
 * transaction, ensures and locks the version row (`SELECT … FOR UPDATE` on
 * Postgres; SQLite has one writer), compares, runs the action inside the
 * same transaction (@strapi/database joins an ambient transaction, C5/C8)
 * and advances the revision after it. Create and clone lock nothing (there
 * is no document yet) and insert revision 1. A delete, or a discard that
 * removed the document (no published row, C20), removes the row instead;
 * by action, never through `afterDelete`, which fires on every publish.
 *
 * THE SCOPE. The authoring controller (batch 15 lane 15A) runs its
 * Document Service call inside `runInAuthoringScope`. The scope names the
 * document (`uid`, `documentId`), the client's token (`expectedRevision`,
 * from `If-Match`) and what the write gate saw (`observedRevision`, read
 * BEFORE the rows it classified, plus its `classify` function). The lock
 * accepts only when the locked revision equals both. On a mismatch it asks
 * `classify` again, under the lock: no class answers 403/404 (`ClassLost`,
 * the route's `missingClass`), a class 412 (`RevisionStale` with the
 * current revision). So a caller who predicts the next revision cannot
 * ride on a gate decision about an older state (amendment row A2), and a
 * caller who lost the class never learns the new revision. Without a
 * scope (admin panel, scheduler, generic routes, boot writers) the lock
 * compares nothing, but it still locks and advances: every source moves
 * the revision, so a web form detects a panel save, a publish, a discard
 * or a scheduler run.
 *
 * After each mutation of the scope's document the lock moves the scope's
 * tokens to the new revision and records it as `committedRevision` (the
 * `ETag` the controller answers with). A request that runs two mutations
 * in one transaction is checked once, against the client's token.
 *
 * OTHER RAW WRITERS (§G "Rule"): a raw write of a guarded document's rows
 * must run under `lockDocument` and call `advanceRevision`, or only raise a
 * targeting flag. raw-writers.test.ts keeps the inventory.
 */

export const CONTENT_VERSION_UID = "api::content-version.content-version";

export const DOCUMENT_LOCK_LOG = "[document-lock]";

/** The Document Service actions that write rows (repository.js). */
export const MUTATING_ACTIONS: readonly string[] = [
  "create",
  "update",
  "clone",
  "delete",
  "publish",
  "unpublish",
  "discardDraft",
];

/** The actions that act on an existing document (they lock and compare). */
const DOCUMENT_ACTIONS: readonly string[] = [
  "update",
  "delete",
  "publish",
  "unpublish",
  "discardDraft",
];

// ---------------------------------------------------------------------------
// The authoring scope.

/** Where a change came from, as the audit trail records it (§H, S12; utils/audit.ts). */
export type AuditSource = "content-api" | "admin" | "cron" | "system";

/** The document a scope or a lock is about. */
export interface DocumentRef {
  uid: string;
  documentId: string;
}

/**
 * The write gate's class decision, run again by the lock on a mismatch,
 * inside the transaction and after the lock is held: it re-reads the rows
 * it needs and answers the caller's class, or null when the caller no
 * longer holds one.
 */
export type ScopeClassifier = (target: DocumentRef) => Promise<string | null>;

/**
 * What a request (or the scheduler) tells the Document Service middlewares
 * about itself. Every field is optional; a scope without tokens compares
 * nothing.
 */
export interface AuthoringScope {
  /** The type of the document the tokens are about. */
  uid?: string;
  /**
   * The document the tokens are about. Unset on a create: the create of
   * `uid` binds it to the new document.
   */
  documentId?: string;
  /** The client's token (`If-Match`). */
  expectedRevision?: number;
  /** The revision the write gate read before the rows it classified. */
  observedRevision?: number;
  /** The gate's classifier (see ScopeClassifier). */
  classify?: ScopeClassifier;
  /** The class the gate admitted the caller as (audit `actorClass`). */
  roleClass?: string | null;
  /** How the route answers a caller without a class: 403 or 404 (default). */
  missingClass?: 403 | 404;
  /** Set by the lock: the revision the last mutation of the document committed. */
  committedRevision?: number;
  /** Overrides the audit source (the scheduler sets `cron`). */
  source?: AuditSource;
}

const scopeStorage = new AsyncLocalStorage<AuthoringScope>();

/**
 * Runs `fn` with `scope` as the authoring scope. The scope object itself is
 * kept (not copied), so the caller reads `committedRevision` from it
 * afterwards.
 */
export function runInAuthoringScope<T>(scope: AuthoringScope, fn: () => T): T {
  return scopeStorage.run(scope, fn);
}

/** The scope of the running request or task, if any. */
export function getAuthoringScope(): AuthoringScope | undefined {
  return scopeStorage.getStore();
}

// ---------------------------------------------------------------------------
// Errors (15A's controller maps them to Strapi's error envelope).

export type DocumentLockStatus = 403 | 404 | 412 | 428;

/** The base of the lock's refusals: an HTTP status plus Strapi-style details. */
export class DocumentLockError extends Error {
  readonly status: DocumentLockStatus;
  readonly details: Record<string, unknown>;

  constructor(
    name: string,
    status: DocumentLockStatus,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = name;
    this.status = status;
    this.details = details;
  }
}

/** 428: a mutation without `If-Match`. */
export class RevisionRequired extends DocumentLockError {
  constructor() {
    super(
      "PreconditionRequiredError",
      428,
      'This change needs If-Match: "<revision>" (the version the form was loaded with)',
    );
  }
}

/** 412: the document changed since the client (or the gate) read it. */
export class RevisionStale extends DocumentLockError {
  readonly current: number;

  constructor(current: number) {
    super(
      "PreconditionFailedError",
      412,
      "The document was changed by someone else since you loaded it",
      { current },
    );
    this.current = current;
  }
}

/** 403/404: the caller lost the class between the gate and the lock. */
export class ClassLost extends DocumentLockError {
  constructor(status: 403 | 404) {
    super(
      status === 403 ? "ForbiddenError" : "NotFoundError",
      status,
      status === 403 ? "Forbidden" : "Not Found",
    );
  }
}

/** `If-Match: "<n>"` (or a bare n) → n; anything else → RevisionRequired. */
export function parseIfMatch(header: unknown): number {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") throw new RevisionRequired();
  const match = /^\s*"?(\d{1,9})"?\s*$/.exec(value);
  if (!match) throw new RevisionRequired();
  return Number(match[1]);
}

/** The `ETag` value for a revision. */
export const etagOf = (revision: number): string => `"${revision}"`;

// ---------------------------------------------------------------------------
// The version row.

interface KnexBuilder {
  transacting(trx: unknown): KnexBuilder;
  insert(row: Record<string, unknown>): KnexBuilder;
  onConflict(columns: string[]): { ignore(): Promise<unknown> };
  select(...columns: string[]): KnexBuilder;
  where(where: Record<string, unknown>): KnexBuilder;
  first(): KnexBuilder;
  forUpdate(): KnexBuilder;
  update(data: Record<string, unknown>): Promise<unknown>;
  del(): Promise<unknown>;
  then<R>(onfulfilled: (value: unknown) => R): Promise<R>;
}

interface ModelMeta {
  tableName: string;
  attributes: Record<string, { columnName?: string } | undefined>;
}

/** The slice of the Strapi instance the revision API uses. */
export interface DocumentLockHost {
  db: {
    getConnection(table: string): KnexBuilder;
    connection: { raw(sql: string, bindings?: readonly unknown[]): unknown };
    transaction<T>(callback: (scope: { trx: unknown }) => Promise<T>): Promise<T>;
    inTransaction(): boolean;
    metadata: { get(uid: string): ModelMeta };
    query(uid: string): {
      findOne(params: Record<string, unknown>): Promise<Record<string, unknown> | null>;
    };
  };
}

interface VersionTable {
  table: string;
  documentId: string;
  targetUid: string;
  targetDocumentId: string;
  revision: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string;
}

/** Table and column names of content_versions, from Strapi's metadata. */
export function versionTable(strapi: Pick<DocumentLockHost, "db">): VersionTable {
  const meta = strapi.db.metadata.get(CONTENT_VERSION_UID);
  if (!meta?.tableName) {
    throw new Error(`${DOCUMENT_LOCK_LOG} the content-version model is not loaded`);
  }
  const column = (attribute: string, fallback: string) =>
    meta.attributes?.[attribute]?.columnName ?? fallback;
  return {
    table: meta.tableName,
    documentId: column("documentId", "document_id"),
    targetUid: column("targetUid", "target_uid"),
    targetDocumentId: column("targetDocumentId", "target_document_id"),
    revision: column("revision", "revision"),
    createdAt: column("createdAt", "created_at"),
    updatedAt: column("updatedAt", "updated_at"),
    publishedAt: column("publishedAt", "published_at"),
  };
}

/** A Strapi-like documentId for the version row itself (24 chars, a-z0-9). */
function versionRowDocumentId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(23);
  let id = "v";
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return id;
}

const isDocumentId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function assertRef(uid: unknown, documentId: unknown): void {
  if (typeof uid !== "string" || uid === "" || !isDocumentId(documentId)) {
    throw new Error(`${DOCUMENT_LOCK_LOG} a revision needs a uid and a documentId`);
  }
}

function assertInTransaction(strapi: DocumentLockHost, what: string): void {
  if (!strapi.db.inTransaction()) {
    throw new Error(
      `${DOCUMENT_LOCK_LOG} ${what} must run inside a transaction (strapi.db.transaction): ` +
        "a lock outside one is released at once",
    );
  }
}

const toRevision = (value: unknown): number => {
  const revision = typeof value === "string" ? Number(value) : value;
  return typeof revision === "number" && Number.isInteger(revision) && revision >= 0 ? revision : 0;
};

/** Inserts the version row with revision 0 unless it exists (joins the ambient transaction). */
async function ensureRow(
  strapi: DocumentLockHost,
  trx: unknown,
  t: VersionTable,
  uid: string,
  documentId: string,
): Promise<void> {
  const now = new Date();
  await strapi.db
    .getConnection(t.table)
    .transacting(trx)
    .insert({
      [t.documentId]: versionRowDocumentId(),
      [t.targetUid]: uid,
      [t.targetDocumentId]: documentId,
      [t.revision]: 0,
      [t.createdAt]: now,
      [t.updatedAt]: now,
      [t.publishedAt]: now,
    })
    .onConflict([t.targetUid, t.targetDocumentId])
    .ignore();
}

async function selectRevision(
  strapi: DocumentLockHost,
  trx: unknown,
  t: VersionTable,
  uid: string,
  documentId: string,
  forUpdate: boolean,
): Promise<number> {
  let query = strapi.db
    .getConnection(t.table)
    .transacting(trx)
    .select(t.revision)
    .where({ [t.targetUid]: uid, [t.targetDocumentId]: documentId })
    .first();
  if (forUpdate) query = query.forUpdate();
  const row = (await query) as Record<string, unknown> | undefined;
  return toRevision(row?.[t.revision]);
}

/**
 * Inside a transaction: ensures the document's version row (`insert … on
 * conflict do nothing`), locks it `FOR UPDATE` (Postgres; SQLite has one
 * writer) and returns its revision. The lock holds until the transaction
 * ends. Lock order (§G2): the document's own row first, then other
 * documents' rows in ascending key order.
 */
export async function lockDocument(
  strapi: DocumentLockHost,
  uid: string,
  documentId: string,
): Promise<number> {
  assertRef(uid, documentId);
  assertInTransaction(strapi, "lockDocument");
  const t = versionTable(strapi);
  return strapi.db.transaction(async ({ trx }) => {
    await ensureRow(strapi, trx, t, uid, documentId);
    return selectRevision(strapi, trx, t, uid, documentId, true);
  });
}

/** The document's revision (0 without a version row). Never writes. */
export async function readRevision(
  strapi: DocumentLockHost,
  uid: string,
  documentId: string,
): Promise<number> {
  assertRef(uid, documentId);
  // The query engine joins an ambient transaction (on SQLite's single
  // connection a separate read would wait for it forever).
  const row = await strapi.db.query(CONTENT_VERSION_UID).findOne({
    where: { targetUid: uid, targetDocumentId: documentId },
    select: ["revision"],
  });
  return toRevision(row?.revision);
}

/**
 * Inside a transaction: raises the document's revision by one (creating
 * the row at 1 when it has none) and returns the new revision. Callers
 * that write a document's rows outside the Document Service lock it first
 * (`lockDocument`).
 */
export async function advanceRevision(
  strapi: DocumentLockHost,
  uid: string,
  documentId: string,
): Promise<number> {
  assertRef(uid, documentId);
  assertInTransaction(strapi, "advanceRevision");
  const t = versionTable(strapi);
  return strapi.db.transaction(async ({ trx }) => {
    await ensureRow(strapi, trx, t, uid, documentId);
    await strapi.db
      .getConnection(t.table)
      .transacting(trx)
      .where({ [t.targetUid]: uid, [t.targetDocumentId]: documentId })
      .update({
        [t.revision]: strapi.db.connection.raw("?? + 1", [t.revision]),
        [t.updatedAt]: new Date(),
      });
    return selectRevision(strapi, trx, t, uid, documentId, false);
  });
}

/** Inside a transaction: removes the document's version row (the document is gone). */
export async function removeRevision(
  strapi: DocumentLockHost,
  uid: string,
  documentId: string,
): Promise<void> {
  assertRef(uid, documentId);
  assertInTransaction(strapi, "removeRevision");
  const t = versionTable(strapi);
  await strapi.db.transaction(async ({ trx }) => {
    await strapi.db
      .getConnection(t.table)
      .transacting(trx)
      .where({ [t.targetUid]: uid, [t.targetDocumentId]: documentId })
      .del();
  });
}

// ---------------------------------------------------------------------------
// The middleware.

/** What @strapi/core hands a Document Service middleware (C4). */
export interface DocumentActionContext {
  uid?: string;
  action?: string;
  params?: unknown;
  contentType?: { attributes?: Record<string, { type?: string } | undefined> };
}

export type DocumentActionMiddleware = (
  context: DocumentActionContext,
  next: () => Promise<unknown>,
) => Promise<unknown>;

/** What the lock tells the inner middlewares about the running action. */
export interface LockedAction {
  uid: string;
  /** The document; for create and clone the new one, known after `next()`. */
  documentId?: string;
  /** The revision this action commits (the locked value + 1; 1 for create and clone). */
  revision: number;
}

// One context object travels through the whole chain of an action (C4).
const lockedActions = new WeakMap<object, LockedAction>();

/** The lock's record of the running action, for the inner middlewares (the audit recorder). */
export function lockedActionOf(context: object): LockedAction | undefined {
  return lockedActions.get(context);
}

/** The Strapi slice the middleware needs on top of the revision API. */
export interface DocumentLockMiddlewareHost extends DocumentLockHost {
  db: DocumentLockHost["db"] & {
    query(uid: string): {
      findOne(params: Record<string, unknown>): Promise<Record<string, unknown> | null>;
      count(params: Record<string, unknown>): Promise<number>;
    };
  };
}

/**
 * The document-lock middleware (see the module comment). Implemented in the
 * lane's lock commit; registered by bootstrap/document-middlewares.ts.
 */
export function createDocumentLock(strapi: DocumentLockMiddlewareHost): DocumentActionMiddleware {
  void strapi;
  void isGuardedUid;
  void DOCUMENT_ACTIONS;
  void lockedActions;
  return async () => {
    throw new Error(`${DOCUMENT_LOCK_LOG} not implemented yet`);
  };
}
