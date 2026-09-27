import type { PollTargeting, PollViewer } from "./poll-audience";

/**
 * DB-facing half of poll targeting (decision 02): loads the inputs that
 * the pure rules in `poll-audience.ts` decide on. Used by the
 * `poll-visibility` read policy and the vote/results controllers.
 *
 * Every read goes through `strapi.db.query`, which needs no relation
 * `.find` scope (guest holds none on department) and spans draft AND
 * published rows, so each loader says which rows it wants.
 */

export const POLL_UID = "api::poll.poll";
export const USER_UID = "plugin::users-permissions.user";

/** Postgres `integer` primary keys; a larger id would fail the query (500). */
const MAX_ROW_ID = 2147483647;

interface FindOneQuery {
  findOne(params: Record<string, unknown>): Promise<unknown>;
}

/** The slice of the Strapi instance these loaders use. */
export interface PollAccessHost {
  db: { query(uid: string): FindOneQuery };
}

/** `ctx.state.user` as users-permissions sets it (role populated). */
export interface PollCaller {
  id: number;
  role?: { type?: string | null } | null;
}

/** One department of a poll, as the results endpoint reports it. */
export interface PollDepartment {
  documentId?: string | null;
  name?: string | null;
}

/** A published poll row with what vote/results need. */
export interface PublishedPoll extends PollTargeting {
  id: number;
  documentId: string;
  question: string;
  options: unknown;
  closesAt: string | Date | null;
  anonymous: boolean | null;
  audience: string | null;
  departments: PollDepartment[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * documentId of the user's own `user.department`, or null without one.
 * A user has at most one department document (manyToOne), and any copy of
 * it carries the same documentId. The other audience checks compare
 * numeric department ids through `loadUserScope` (visible-ids.ts), which
 * decision 05 (single-row departments) made correct; polls keep this
 * documentId-based loader on purpose (see poll-audience.ts).
 */
export async function loadUserDepartmentDocumentId(
  strapi: PollAccessHost,
  userId: number,
): Promise<string | null> {
  const row = await strapi.db.query(USER_UID).findOne({
    where: { id: userId },
    select: ["id"],
    populate: { department: { select: ["documentId"] } },
  });
  const department = isRecord(row) ? row.department : null;
  const documentId = isRecord(department) ? department.documentId : null;
  return typeof documentId === "string" && documentId.length > 0 ? documentId : null;
}

/**
 * The caller as the poll rules see them. The role comes from
 * `ctx.state.user` (users-permissions populates it), the department from
 * the database: a department change applies on the next request.
 */
export async function loadPollViewer(strapi: PollAccessHost, user: PollCaller): Promise<PollViewer> {
  return {
    roleType: user.role?.type ?? null,
    departmentDocumentId: await loadUserDepartmentDocumentId(strapi, user.id),
  };
}

/**
 * The route's `:id` as a published poll row id, or null for anything that
 * is not a plain positive decimal integer inside the column range.
 */
export function parsePollRowId(rawId: unknown): number | null {
  const text = typeof rawId === "number" ? String(rawId) : rawId;
  if (typeof text !== "string" || !/^[1-9][0-9]{0,9}$/.test(text)) return null;
  const id = Number(text);
  return id <= MAX_ROW_ID ? id : null;
}

/**
 * The PUBLISHED poll row with numeric id `rawId`, or null: a malformed
 * id, a missing row and a draft row all answer null, so the controllers
 * give the same 404 for each (no existence oracle).
 */
export async function loadPublishedPoll(
  strapi: PollAccessHost,
  rawId: unknown,
): Promise<PublishedPoll | null> {
  const id = parsePollRowId(rawId);
  if (id === null) return null;
  const row = await strapi.db.query(POLL_UID).findOne({
    where: { id, publishedAt: { $notNull: true } },
    select: ["id", "documentId", "question", "options", "closesAt", "anonymous", "audience"],
    populate: { departments: { select: ["documentId", "name"] } },
  });
  if (!isRecord(row) || typeof row.id !== "number") return null;
  return {
    id: row.id,
    documentId: typeof row.documentId === "string" ? row.documentId : "",
    question: typeof row.question === "string" ? row.question : "",
    options: row.options,
    closesAt: typeof row.closesAt === "string" || row.closesAt instanceof Date ? row.closesAt : null,
    anonymous: row.anonymous == null ? null : Boolean(row.anonymous),
    audience: typeof row.audience === "string" ? row.audience : null,
    departments: Array.isArray(row.departments)
      ? row.departments.filter(isRecord).map((department) => ({
          documentId: typeof department.documentId === "string" ? department.documentId : null,
          name: typeof department.name === "string" ? department.name : null,
        }))
      : [],
  };
}
