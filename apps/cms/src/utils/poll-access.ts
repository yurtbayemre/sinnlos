import { parseEntryRef, type EntryRef } from "./entry-id";
import {
  canVoteOnPoll,
  isPollTargeted,
  type PollTargeting,
  type PollViewer,
} from "./poll-audience";
import { MAX_BATCHED_POLLS, type BallotTally } from "./poll-ballots";

/**
 * DB-facing half of poll targeting (decision 02): loads the inputs that
 * the pure rules in `poll-audience.ts` decide on, and builds the results
 * body from those rules. Used by the `poll-visibility` read policy, the
 * vote/results controllers and the batched GET /api/poll-results (WD04).
 *
 * Every read goes through `strapi.db.query`, which needs no relation
 * `.find` scope (guest holds none on department) and spans draft AND
 * published rows, so each loader says which rows it wants.
 */

export const POLL_UID = "api::poll.poll";
export const USER_UID = "plugin::users-permissions.user";

interface FindOneQuery {
  findOne(params: Record<string, unknown>): Promise<unknown>;
}

interface FindManyQuery {
  findMany(params: Record<string, unknown>): Promise<unknown>;
}

/** The slice of the Strapi instance these loaders use. */
export interface PollAccessHost {
  db: { query(uid: string): FindOneQuery };
}

/** The slice the batched loader uses. */
export interface PollListHost {
  db: { query(uid: string): FindManyQuery };
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
  /** Strictly true only when the column is true (NULL/false = hidden from guests). */
  visibleToGuests: boolean;
  /** Strictly true only when the column is true (see poll-audience.ts). */
  guestsCanVote: boolean;
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
 * The PUBLISHED row of the poll addressed by `rawRef`, or null: a malformed
 * reference, a missing poll and a draft-only poll all answer null, so the
 * controllers give the same 404 for each (no existence oracle).
 *
 * `rawRef` (the route's `:id`) is read by `parseEntryRef`
 * (utils/entry-id.ts, DA01):
 *   - a documentId in Strapi's shape: the poll's stable address, which the
 *     web sends. Publishing replaces the published row (delete + recreate,
 *     a new row id), the documentId stays;
 *   - a row id (a positive integer within int4, as a number or a canonical
 *     decimal string): the numeric fallback for callers from before DA01.
 *     A draft row's id finds nothing, as before.
 * Anything else answers null without a query: Postgres fails an int4 lookup
 * on a malformed id (a 500). Either way the lookup is pinned to the
 * published row, and the caller works with that row's id (the vote stores
 * it, the results count its votes; the poll-vote.poll link follows a
 * republish to the new published row).
 */
export async function loadPublishedPoll(
  strapi: PollAccessHost,
  rawRef: unknown,
): Promise<PublishedPoll | null> {
  const ref = parseEntryRef(rawRef);
  if (ref === null) return null;
  const row = await strapi.db.query(POLL_UID).findOne({
    where: { ...ref, publishedAt: { $notNull: true } },
    select: POLL_COLUMNS,
    populate: POLL_POPULATE,
  });
  return toPublishedPoll(row);
}

/** The columns and relation every published-poll loader reads. */
const POLL_COLUMNS = [
  "id",
  "documentId",
  "question",
  "options",
  "closesAt",
  "anonymous",
  "audience",
  "visibleToGuests",
  "guestsCanVote",
];
const POLL_POPULATE = { departments: { select: ["documentId", "name"] } };

/**
 * The PUBLISHED rows of the polls addressed by `refs` (parsePollRefs), in
 * the order of `refs`, each at most once (an id and the documentId of the
 * same poll name one poll): ONE query. A missing ref, a draft row and a
 * draft-only document are simply not among them, like loadPublishedPoll's
 * null. The caller still decides visibility per poll (canSeePoll).
 */
export async function loadPublishedPolls(
  strapi: PollListHost,
  refs: readonly EntryRef[],
): Promise<PublishedPoll[]> {
  const ids = refs.flatMap((ref) => ("id" in ref ? [ref.id] : []));
  const documentIds = refs.flatMap((ref) => ("documentId" in ref ? [ref.documentId] : []));
  if (ids.length === 0 && documentIds.length === 0) return [];
  const rows = await strapi.db.query(POLL_UID).findMany({
    where: {
      publishedAt: { $notNull: true },
      $or: [
        ...(ids.length > 0 ? [{ id: { $in: ids } }] : []),
        ...(documentIds.length > 0 ? [{ documentId: { $in: documentIds } }] : []),
      ],
    },
    select: POLL_COLUMNS,
    populate: POLL_POPULATE,
  });
  const polls = (Array.isArray(rows) ? rows : [])
    .map(toPublishedPoll)
    .filter((poll): poll is PublishedPoll => poll !== null);
  const ordered: PublishedPoll[] = [];
  for (const ref of refs) {
    const poll = polls.find((p) =>
      "id" in ref ? p.id === ref.id : p.documentId === ref.documentId,
    );
    if (poll && !ordered.includes(poll)) ordered.push(poll);
  }
  return ordered;
}

/**
 * The `ids` of GET /api/poll-results (WD04): a comma-separated list, or
 * the parameter repeated, of poll documentIds or published row ids
 * (parseEntryRef, like the `:id` of vote/results). Duplicates collapse.
 * A malformed id, none at all or more than MAX_BATCHED_POLLS is an error
 * (400): it says nothing about which polls exist.
 */
export function parsePollRefs(raw: unknown): { refs: EntryRef[] } | { error: string } {
  const parts: unknown[] =
    typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const refs: EntryRef[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (typeof part !== "string") return { error: "Invalid ids" };
    for (const text of part.split(",")) {
      const ref = parseEntryRef(text);
      if (ref === null) return { error: "Invalid ids" };
      const key = "id" in ref ? `id:${ref.id}` : `doc:${ref.documentId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  if (refs.length === 0) return { error: "ids required" };
  if (refs.length > MAX_BATCHED_POLLS) return { error: `At most ${MAX_BATCHED_POLLS} ids` };
  return { refs };
}

const pollOptions = (options: unknown): unknown[] => (Array.isArray(options) ? options : []);

/** The number of options of a published poll (a malformed JSON value has none). */
export function pollOptionCount(poll: PublishedPoll): number {
  return pollOptions(poll.options).length;
}

/**
 * The results body of one poll for one caller, as GET /api/polls/:id/results
 * answers it and GET /api/poll-results lists it: the question and options
 * of the published row, the counts (utils/poll-ballots.ts), the caller's
 * own vote, whether the caller may vote, the targeting summary and the
 * stored guest flags. Never a voter identity. The caller must have
 * checked canSeePoll first. `documentId` is the poll's address (DA01).
 */
export function pollResultsBody(
  poll: PublishedPoll,
  tally: BallotTally,
  viewer: PollViewer | null,
) {
  return {
    poll: {
      id: poll.id,
      documentId: poll.documentId,
      question: poll.question,
      options: pollOptions(poll.options),
      closesAt: poll.closesAt,
      anonymous: poll.anonymous ?? false,
      // The stored guest-access flags as strict booleans (NULL = false);
      // guestsCanVote counts only together with visibleToGuests.
      visibleToGuests: poll.visibleToGuests,
      guestsCanVote: poll.guestsCanVote,
    },
    counts: tally.counts,
    total: tally.total,
    myVoteIndex: tally.myVoteIndex,
    canVote: canVoteOnPoll(poll, viewer),
    audience: {
      targeted: isPollTargeted(poll),
      departments: poll.departments
        .filter((department) => typeof department.documentId === "string")
        .map((department) => ({
          documentId: department.documentId as string,
          name: department.name ?? "",
        })),
    },
  };
}

/** A poll row of either loader as a PublishedPoll, or null when it is none. */
function toPublishedPoll(row: unknown): PublishedPoll | null {
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
    // @strapi/database reads booleans as true/false on every client
    // (fields/boolean.js fromDB); anything else, NULL included, is "no".
    visibleToGuests: row.visibleToGuests === true,
    guestsCanVote: row.guestsCanVote === true,
  };
}
