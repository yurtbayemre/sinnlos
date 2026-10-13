import { samePollOptions } from "@sinnlos/domain";
import { errors } from "@strapi/utils";

import { parseAdminJsonField } from "./json-field";
import { POLL_AUDIENCE_DEPARTMENTS } from "./poll-audience";

/**
 * Write-time enforcement of the poll audience flag (decision 02, fail
 * closed): every poll row that links a department carries
 * `audience = 'departments'` from the moment the write that linked it
 * commits.
 *
 * WHY. A poll is targeted when its flag says so OR it links a department
 * (utils/poll-audience.ts). The links can vanish: deleting a department
 * cascades them (`ON DELETE CASCADE` on polls_departments_lnk). A poll
 * targeted only by its links (the admin panel preselects Audience `all`)
 * would then turn company-wide. The department delete hook
 * (poll-department-delete.ts) flags the polls it finds before the delete,
 * but under Read Committed a poll created and committed by another
 * transaction after that scan kept its flag at `all`, and the cascade then
 * opened it (Codex review, finding 1). With this guard that poll already
 * carries the flag when its link becomes visible to anyone: the flag and
 * the link commit in the same transaction. Postgres serialises the rest:
 * inserting a link row takes a KEY SHARE lock on the department row (FK
 * check), so a link inserted while the delete is in flight either waits and
 * then fails the FK check, or was committed first and is cascaded by the
 * delete with its flag already set.
 *
 * HOW. A Document Service middleware (`strapi.documents.use`), registered
 * in register(). @strapi/core 5.55.1 wraps every repository method in it
 * (services/document-service/index.js createDocumentService →
 * middlewares/middleware-manager.js wrapObject: ctx = { uid, contentType,
 * action, params }, then the repository call). The repository opens its own
 * transaction per action (document-service/common.js wrapInTransaction →
 * `strapi.db.transaction`), and @strapi/database 5.55.1 joins an ambient
 * transaction instead of opening one when its AsyncLocalStorage holds one
 * (index.js transaction: `notNestedTransaction`, commit/rollback only at
 * the outermost level; transaction-context.js). So this middleware opens
 * the transaction FIRST, runs the action inside it (`next()`), then flags,
 * and the outermost commit covers both. Every query builder `execute()`
 * picks the ambient transaction up (query/query-builder.js execute:
 * `transactionCtx.get()`), the entity manager's own relation transactions
 * nest the same way (entity-manager/index.js create/update/delete), and the
 * document events wait for the outer commit (document-service/events.js
 * emitEvent → onCommit), so they see the flagged row. A failing flag step
 * rolls the whole action back.
 *
 * WHAT IT COVERS. Every writer of poll rows goes through the Document
 * Service: the Content Manager (single create/update/clone/publish/
 * unpublish/discard, and bulk publish/unpublish as per-document calls in
 * one transaction: content-manager dist/server/services/document-manager.js),
 * content history restore (history/services/history.js restoreVersion →
 * documents.update, EE only), the content API (core-api service/
 * collection-type.js create/update, `status: 'published'` by default,
 * core-service.js getFetchParams), the entity service shim (services/
 * entity-service/index.js delegates to documents), the demo seed
 * (seed-demo.ts, documents.create) and the draft-twin repair (draft-twins.ts,
 * documents.discardDraft). The boot backfill (poll-audience-backfill.ts) and
 * the department delete hook write only the flag, never links. Nothing in
 * this app writes poll links through `strapi.db.query` or raw SQL.
 *
 * ACTIONS. The writing actions of the repository (repository.js return
 * value), the same list Strapi's own history middleware reacts to
 * (content-manager history/services/lifecycles.js shouldCreateHistoryVersion):
 * create, update, clone, publish, unpublish, discardDraft. `create` and
 * `update` with `status: 'published'` publish inside the action
 * (repository.js create/update → publish, not through the middleware), and
 * publish/discardDraft delete and re-create rows, so after each action
 * EVERY row of the document is checked, not just the one the action
 * returns. `delete` leaves no row to flag; reads pass through untouched,
 * without a transaction.
 *
 * NEVER WIDENS. The guard only ever sets 'departments', and only on rows
 * that link a department (which the links already restrict). Making a poll
 * company-wide stays an explicit edit: remove its departments AND set
 * Audience to `all` (the web form does both; in the admin panel, setting
 * `all` while departments remain is flipped back to 'departments').
 *
 * `updateMany` with a plain object payload leaves `updatedAt` alone
 * (@strapi/database lifecycles/subscribers/timestamps.js beforeUpdateMany
 * only stamps array payloads), so the admin panel keeps showing Published,
 * not Modified. The action's own result is patched to the stored flag, so
 * the admin form and the API response show what was saved.
 *
 * SHARED. `createAudienceGuard` builds this middleware for any list of
 * content types with a `departments` relation and an `audience` flag:
 * documents and quick links use it too, with their own log prefix
 * (utils/department-audience-guard.ts).
 *
 * THE VOTE FREEZE (deep-dive decision 06 §G2 poll row; batch 15 plan item
 * 8). The poll guard (`createPollAudienceGuard`, slot 3a of
 * bootstrap/document-middlewares.ts) also refuses, before the write, any
 * action that would change what voters voted on: a poll's `options`
 * (index by index, after trimming: votes store an option INDEX) and its
 * `anonymous` switch (anonymous to named would expose voters), once a vote
 * exists. Votes are cast on the PUBLISHED row (utils/poll-access.ts
 * loadPublishedPoll), so the comparison is with the currently published
 * row, never with the stored draft or the payload alone:
 *   - `publish`: the draft as it stands becomes the published row;
 *   - `update` with `status: 'published'`: the draft overlaid with the
 *     payload becomes the published row, without a `publish` pass through
 *     the chain (C3). A web save that changes only `closesAt` publishes a
 *     panel draft's changed options with it, so the merged draft is
 *     compared;
 *   - a draft-only `update` that carries `options` or `anonymous` and makes
 *     them differ: a voted poll must not collect a draft that can never be
 *     published;
 *   - `create` and `clone` start a new document (no votes), `discardDraft`
 *     leaves the published row as it is, `unpublish` removes it.
 * A difference with a vote answers 400 `ValidationError` with
 * `details.keys` and `details.codes: frozenAfterVotes`; nothing is written.
 * It runs under the poll's lock: the document lock (slot 2) holds the
 * poll's version row FOR UPDATE for the whole action, and the vote handler
 * (api/poll-vote/controllers/poll-vote.ts) takes the same lock before it
 * reads, checks and inserts, so a vote and an options change sent at the
 * same moment serialise and one of them is refused. The admin panel is
 * bound too (release note 6). The authoring allowlist refuses the same
 * change earlier with the same comparison (`frozenWhen`,
 * utils/write-allowlist.ts).
 */

export const POLL_AUDIENCE_GUARD_LOG = "[poll-audience]";

const POLL_UID = "api::poll.poll";

/**
 * Document Service actions that write rows (see the header), the same for
 * every type the guard covers.
 */
export const POLL_WRITE_ACTIONS: readonly string[] = [
  "create",
  "update",
  "clone",
  "publish",
  "unpublish",
  "discardDraft",
];

/** documentIds per lookup and ids per UPDATE (well below every bind limit). */
export const POLL_AUDIENCE_GUARD_CHUNK = 200;

interface FlagWriteQuery {
  updateMany(params: Record<string, unknown>): Promise<{ count?: number } | undefined>;
}

interface GuardQuery extends FlagWriteQuery {
  findMany(params: Record<string, unknown>): Promise<unknown[]>;
  /** The vote freeze counts ballots (the real query engine always has it). */
  count?(params: Record<string, unknown>): Promise<number>;
}

/** What @strapi/core hands a Document Service middleware. */
export interface DocumentMiddlewareContext {
  uid?: string;
  action?: string;
  params?: unknown;
}

export type DocumentMiddleware = (
  context: DocumentMiddlewareContext,
  next: () => Promise<unknown>,
) => Promise<unknown>;

/** The slice of the Strapi instance the guard uses. */
export interface PollAudienceGuardHost {
  db: {
    query(uid: string): GuardQuery;
    transaction<T>(callback: () => Promise<T>): Promise<T>;
  };
  log: { info(message: string): void };
}

/** register() also needs `strapi.documents.use`. */
export interface PollAudienceGuardRegistrationHost extends PollAudienceGuardHost {
  documents?: { use?: (middleware: DocumentMiddleware) => unknown } | null;
}

/** A content type the guard covers: its uid and the label its log line names. */
export interface AudienceGuardType {
  uid: string;
  label: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Sets `audience = 'departments'` on those of `ids` (poll row ids) whose
 * flag is NULL or anything else, in chunks. Returns the number of rows
 * changed. Shared with the department delete hook.
 */
export async function setDepartmentsFlag(
  query: FlagWriteQuery,
  ids: readonly number[],
): Promise<number> {
  let changed = 0;
  for (let start = 0; start < ids.length; start += POLL_AUDIENCE_GUARD_CHUNK) {
    const chunk = ids.slice(start, start + POLL_AUDIENCE_GUARD_CHUNK);
    const result = await query.updateMany({
      where: {
        id: { $in: chunk },
        $or: [{ audience: { $null: true } }, { audience: { $ne: POLL_AUDIENCE_DEPARTMENTS } }],
      },
      data: { audience: POLL_AUDIENCE_DEPARTMENTS },
    });
    changed += result?.count ?? 0;
  }
  return changed;
}

/**
 * Flags every row (draft and published alike) of the given documents of
 * `uid` that links at least one department and is not flagged
 * 'departments' yet. Returns the ids of the rows it flagged.
 *
 * The departments come from a populate (a query of their own), so the row
 * select joins nothing and cannot turn DISTINCT (§5.39); the populate keeps
 * `id` in its select all the same.
 */
export async function flagLinkedRows(
  strapi: Pick<PollAudienceGuardHost, "db">,
  uid: string,
  documentIds: readonly string[],
): Promise<number[]> {
  const query = strapi.db.query(uid);
  const toFlag: number[] = [];
  for (let start = 0; start < documentIds.length; start += POLL_AUDIENCE_GUARD_CHUNK) {
    const chunk = documentIds.slice(start, start + POLL_AUDIENCE_GUARD_CHUNK);
    const rows = await query.findMany({
      where: { documentId: { $in: chunk } },
      select: ["id", "audience"],
      populate: { departments: { select: ["id", "documentId"] } },
    });
    for (const row of rows) {
      if (!isRecord(row) || typeof row.id !== "number") continue;
      const linked = Array.isArray(row.departments) && row.departments.length > 0;
      if (linked && row.audience !== POLL_AUDIENCE_DEPARTMENTS) toFlag.push(row.id);
    }
  }
  if (toFlag.length > 0) await setDepartmentsFlag(query, toFlag);
  return toFlag;
}

/** The poll documents an action touched: its params and its result. */
export function affectedDocumentIds(params: unknown, result: unknown): string[] {
  const documentIds = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0) documentIds.add(value);
  };
  if (isRecord(params)) add(params.documentId);
  if (isRecord(result)) {
    add(result.documentId);
    if (Array.isArray(result.entries)) {
      for (const entry of result.entries) if (isRecord(entry)) add(entry.documentId);
    }
  }
  return [...documentIds];
}

/** Shows the stored flag in the action's result (a row, or `{ entries }`). */
function patchResult(result: unknown, flagged: ReadonlySet<number>): void {
  if (!isRecord(result)) return;
  const rows: unknown[] = Array.isArray(result.entries) ? result.entries : [result];
  for (const row of rows) {
    if (isRecord(row) && typeof row.id === "number" && flagged.has(row.id) && "audience" in row) {
      row.audience = POLL_AUDIENCE_DEPARTMENTS;
    }
  }
}

/**
 * The middleware (see the header) for `types`, logging
 * `<log> <label> <action>: set the audience of N <label> row(s) …`.
 */
export function createAudienceGuard(
  strapi: PollAudienceGuardHost,
  log: string,
  types: readonly AudienceGuardType[],
  options: {
    /** Runs inside the guard's transaction before the action (the poll's vote freeze). */
    before?: (context: DocumentMiddlewareContext) => Promise<void>;
  } = {},
): DocumentMiddleware {
  return async (context, next) => {
    const action = context.action ?? "";
    const type = types.find((candidate) => candidate.uid === context.uid);
    if (!type || !POLL_WRITE_ACTIONS.includes(action)) return next();
    return strapi.db.transaction(async () => {
      if (options.before) await options.before(context);
      const result = await next();
      const documentIds = affectedDocumentIds(context.params, result);
      const flagged = await flagLinkedRows(strapi, type.uid, documentIds);
      if (flagged.length > 0) {
        patchResult(result, new Set(flagged));
        strapi.log.info(
          `${log} ${type.label} ${action}: set the audience of ${flagged.length} ${type.label} row(s) ` +
            `to 'departments' (they link a department)`,
        );
      }
      return result;
    });
  };
}

const POLL_VOTE_UID = "api::poll-vote.poll-vote";

/** The poll fields a vote depends on (see THE VOTE FREEZE). */
export const POLL_FROZEN_FIELDS = ["options", "anonymous"] as const;

/** The code of a refused change to a voted poll (@sinnlos/domain authoring/codes.ts). */
export const FROZEN_AFTER_VOTES = "frozenAfterVotes";

type FrozenField = (typeof POLL_FROZEN_FIELDS)[number];

/** Whether two values of a frozen field say the same to a voter. */
function sameFrozen(field: FrozenField, a: unknown, b: unknown): boolean {
  if (field === "anonymous") return (a === true) === (b === true);
  return samePollOptions(a, b);
}

/** The value an update writes into a frozen field (admin JSON text parsed), or null to skip it. */
function written(field: FrozenField, raw: unknown): { value: unknown } | null {
  if (field !== "options") return { value: raw };
  const parsed = parseAdminJsonField(raw);
  // Unparsable admin JSON: the poll lifecycle refuses it.
  return parsed.ok ? { value: parsed.value } : null;
}

/**
 * The frozen fields an action would change against the published row (see
 * THE VOTE FREEZE), before any vote is counted.
 */
export function frozenChanges(
  action: string,
  params: unknown,
  draft: Record<string, unknown> | null,
  published: Record<string, unknown> | null,
): FrozenField[] {
  if (!published || (action !== "publish" && action !== "update")) return [];
  const data = isRecord(params) && isRecord(params.data) ? params.data : {};
  const status = isRecord(params) ? params.status : undefined;
  const publishes = action === "publish" || status === "published";
  const changed: FrozenField[] = [];
  for (const field of POLL_FROZEN_FIELDS) {
    const carried = action === "update" && field in data && data[field] !== undefined;
    if (!publishes && !carried) continue;
    let next: unknown = draft?.[field];
    if (carried) {
      const value = written(field, data[field]);
      if (!value) continue;
      next = value.value;
    }
    if (!sameFrozen(field, next, published[field])) changed.push(field);
  }
  return changed;
}

/**
 * Throws `frozenAfterVotes` when the action would change a frozen field of
 * a poll that has a vote (see THE VOTE FREEZE). Runs inside the action's
 * transaction, under the poll's lock (slot 2).
 */
export async function assertPollNotFrozen(
  strapi: Pick<PollAudienceGuardHost, "db">,
  action: string,
  params: unknown,
): Promise<void> {
  if (action !== "publish" && action !== "update") return;
  const documentId = isRecord(params) ? params.documentId : undefined;
  if (typeof documentId !== "string" || documentId === "") return;
  const rows = await strapi.db.query(POLL_UID).findMany({
    where: { documentId },
    select: ["id", "publishedAt", "options", "anonymous"],
  });
  const list = (Array.isArray(rows) ? rows : []).filter(isRecord);
  const draft = list.find((row) => row.publishedAt == null) ?? null;
  const published = list.find((row) => row.publishedAt != null) ?? null;
  const changed = frozenChanges(action, params, draft, published);
  if (changed.length === 0) return;
  const votes = strapi.db.query(POLL_VOTE_UID);
  if (typeof votes.count !== "function") {
    throw new Error(`${POLL_AUDIENCE_GUARD_LOG} the vote freeze needs db.query().count`);
  }
  const ballots = await votes.count({ where: { poll: { documentId } } });
  if (ballots === 0) return;
  const keys = [...changed].sort();
  throw new errors.ValidationError(
    `This poll has votes: ${keys.join(" and ")} can no longer change`,
    { keys, codes: Object.fromEntries(keys.map((key) => [key, FROZEN_AFTER_VOTES])) },
  );
}

/**
 * The poll guard: the vote freeze before the write, the audience flag
 * after it, in the guard's one transaction (joined into the document
 * lock's, slot 2).
 */
export function createPollAudienceGuard(strapi: PollAudienceGuardHost): DocumentMiddleware {
  return createAudienceGuard(strapi, POLL_AUDIENCE_GUARD_LOG, [{ uid: POLL_UID, label: "poll" }], {
    before: (context) => assertPollNotFrozen(strapi, context.action ?? "", context.params),
  });
}

/**
 * Hangs `middleware` onto the Document Service, or throws `refusal` when
 * the Document Service has no `use` (a Strapi upgrade moved it): the cms
 * must not run without its guards.
 */
export function useDocumentMiddleware(
  strapi: PollAudienceGuardRegistrationHost,
  middleware: DocumentMiddleware,
  refusal: string,
): void {
  const documents = strapi.documents;
  if (!documents || typeof documents.use !== "function") throw new Error(refusal);
  documents.use(middleware);
}

/**
 * Registers the guard. Fails the boot when the Document Service has no
 * `use` (a Strapi upgrade moved it): the cms must not run without it.
 */
export function registerPollAudienceGuard(strapi: PollAudienceGuardRegistrationHost): void {
  useDocumentMiddleware(
    strapi,
    createPollAudienceGuard(strapi),
    `${POLL_AUDIENCE_GUARD_LOG} strapi.documents.use not found — refusing to boot without the write-time poll audience guard`,
  );
}
