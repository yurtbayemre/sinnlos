import { afterEach, describe, expect, it, vi } from "vitest";
import { MALFORMED_ENTRY_IDS, failLikePostgres } from "../../../utils/entry-id.test.helper";
import { countPollBallots, tallyBallots } from "../../../utils/poll-ballots";
import pollVoteController from "./poll-vote";

/**
 * The custom vote/results handlers (decision 02 + FX06 + FX20 + DA01). They
 * look polls up by documentId (the web's address) or by the numeric id of
 * the published row (the fallback) through strapi.db.query, which spans
 * draft AND published rows, so:
 *   - both addresses resolve to the PUBLISHED row: a documentId whose
 *     document has a draft and a published row votes on and counts the
 *     published one (the stubs hold both twins);
 *   - a missing id, a malformed id, a draft row, a draft-only document and
 *     a poll outside the caller's department audience answer the same 404;
 *     a malformed id (anything `parseEntryRef` in utils/entry-id.ts
 *     refuses) never reaches the poll query, which fails like Postgres on
 *     an id an int4 column cannot hold,
 *   - admin_role/editor read every poll and its results but vote only in
 *     the audience (403 outside it),
 *   - a guest (owner decision 2026-09-27) gets the same 404 for a poll that
 *     is not visible to guests (NULL flags included), and 403 "Guests
 *     cannot vote on this poll" on a visible poll without guest voting;
 *     results carry both flags and `canVote` from the same rule,
 *   - the voter is always the caller, whatever the body says,
 *   - a vote that names the option text its card showed (`option`) is
 *     refused with 400 "Poll options changed" when that text is no longer
 *     at the index (options reordered or replaced after the card rendered),
 *     before any vote query; a body without a string `option` is not
 *     compared,
 *   - results never carry voter identities, but do carry the caller's own
 *     vote even on anonymous polls,
 *   - results count one ballot per voter: the voter's first ballot (the
 *     lowest row id), whatever duplicates a parallel race stored, and a
 *     vote deletes the voter's later rows for the poll right after its
 *     insert (answering "Already voted" when its own row was the later one,
 *     or when a parallel vote's cleanup deleted it before create read it
 *     back).
 *
 * The db stub evaluates the `where` it receives, so dropping the published
 * pin or the voter filter fails the tests. Its vote `findMany` also returns
 * what @strapi/database returns for a relation filter: only the selected
 * columns, DISTINCT (see `distinctProjection`).
 *
 * The results count is ONE SQL statement (utils/poll-ballots.ts
 * countPollBallots, FX20), which a stub cannot run: here it is replaced by
 * the reference rule (tallyBallots) over the stub's table, and
 * utils/poll-ballots.engine.test.ts holds the statement equal to that rule
 * on SQLite and Postgres 16 (duplicates, deleted accounts, identical votes,
 * the DISTINCT trap, the single statement).
 */

vi.mock("../../../utils/poll-ballots", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/poll-ballots")>()),
  countPollBallots: vi.fn(),
}));

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        cfg({ strapi }),
  },
}));

interface PollRow {
  id: number;
  documentId: string;
  question: string;
  options: string[];
  closesAt: string | null;
  anonymous: boolean;
  audience: string | null;
  departments: { documentId: string; name: string }[];
  publishedAt: string | null;
  visibleToGuests: boolean | null;
  guestsCanVote: boolean | null;
}

interface VoteRow {
  poll: number;
  /** null: the voter's account is gone (the link row went with it). */
  voter: number | null;
  optionIndex: number;
}

/** A vote as the table holds it: with its primary key. */
interface StoredVoteRow extends VoteRow {
  id: number;
}

interface UserRow {
  id: number;
  role: { type: string };
  department: { id: number; documentId: string } | null;
}

const PUBLISHED_AT = "2026-09-01T00:00:00.000Z";
const ENG = { documentId: "d-eng", name: "Engineering" };

const DRAFT: PollRow = {
  id: 1,
  documentId: "p-restructure",
  question: "Unannounced restructuring?",
  options: ["yes", "no"],
  closesAt: null,
  anonymous: true,
  audience: "all",
  departments: [],
  publishedAt: null,
  visibleToGuests: false,
  guestsCanVote: false,
};
const OPEN: PollRow = {
  ...DRAFT,
  id: 2,
  documentId: "p-lunch",
  question: "Pizza or sushi?",
  anonymous: false,
  publishedAt: PUBLISHED_AT,
};
/** Closes on 2026-09-30 ("closes on D" = 23:59:59 Europe/Berlin). */
const CLOSING: PollRow = {
  ...OPEN,
  id: 3,
  documentId: "p-offsite",
  question: "Offsite location?",
  closesAt: "2026-09-30T21:59:59.000Z",
};
const ENG_ONLY: PollRow = {
  ...OPEN,
  id: 4,
  documentId: "p-eng",
  question: "Which on-call tool?",
  anonymous: true,
  audience: "departments",
  departments: [ENG],
};
const CLOSED: PollRow = { ...OPEN, id: 5, documentId: "p-closed", closesAt: "2020-01-01T00:00:00.000Z" };
/** Guest access (owner decision 2026-09-27): visible to guests, no guest vote. */
const GUEST_VISIBLE: PollRow = { ...OPEN, id: 6, documentId: "p-guest-read", visibleToGuests: true };
/** Visible to guests, and guests may vote. */
const GUEST_VOTABLE: PollRow = {
  ...OPEN,
  id: 7,
  documentId: "p-guest-vote",
  visibleToGuests: true,
  guestsCanVote: true,
};
/** guestsCanVote without visibleToGuests: inert, hidden from guests. */
const GUEST_VOTE_ONLY: PollRow = { ...OPEN, id: 8, documentId: "p-guest-vote-only", guestsCanVote: true };
/** A row from before the guest columns: NULL flags. */
const GUEST_NULL: PollRow = {
  ...OPEN,
  id: 9,
  documentId: "p-legacy",
  audience: null,
  visibleToGuests: null,
  guestsCanVote: null,
};
/** Engineering only, open to guests (of Engineering) with voting. */
const ENG_GUESTS: PollRow = { ...ENG_ONLY, id: 10, documentId: "p-eng-guests", visibleToGuests: true, guestsCanVote: true };
/** Engineering only, visible to guests (of Engineering) without voting. */
const ENG_GUESTS_READ: PollRow = { ...ENG_GUESTS, id: 11, documentId: "p-eng-guests-read", guestsCanVote: false };
/**
 * DA01: one poll document with both rows, addressed by its documentId. The
 * draft row comes first (lower id), as Strapi writes them; only the
 * published one may be voted on or counted.
 */
const TWIN_DOCUMENT_ID = "k3m9x0000000000000000001";
const TWIN_DRAFT: PollRow = { ...OPEN, id: 20, documentId: TWIN_DOCUMENT_ID, question: "Twin (draft)", publishedAt: null };
const TWIN_PUBLISHED: PollRow = { ...OPEN, id: 21, documentId: TWIN_DOCUMENT_ID, question: "Twin" };
/** A document that was never published: a draft row only. */
const DRAFT_ONLY_DOCUMENT_ID = "k3m9x0000000000000000002";
const DRAFT_ONLY: PollRow = { ...DRAFT, id: 22, documentId: DRAFT_ONLY_DOCUMENT_ID };
/** The Engineering-only poll as a document with both rows. */
const ENG_TWIN_DOCUMENT_ID = "k3m9x0000000000000000003";
const ENG_TWIN_DRAFT: PollRow = { ...ENG_ONLY, id: 23, documentId: ENG_TWIN_DOCUMENT_ID, publishedAt: null };
const ENG_TWIN_PUBLISHED: PollRow = { ...ENG_ONLY, id: 24, documentId: ENG_TWIN_DOCUMENT_ID };
const POLLS = [
  TWIN_DRAFT,
  TWIN_PUBLISHED,
  DRAFT_ONLY,
  ENG_TWIN_DRAFT,
  ENG_TWIN_PUBLISHED,
  DRAFT,
  OPEN,
  CLOSING,
  ENG_ONLY,
  CLOSED,
  GUEST_VISIBLE,
  GUEST_VOTABLE,
  GUEST_VOTE_ONLY,
  GUEST_NULL,
  ENG_GUESTS,
  ENG_GUESTS_READ,
];

/**
 * Route ids that name no poll: neither a row id nor a documentId in
 * Strapi's shape (utils/entry-id.ts parseEntryRef).
 */
const MALFORMED_POLL_IDS = [...MALFORMED_ENTRY_IDS, `${TWIN_DOCUMENT_ID}x`, TWIN_DOCUMENT_ID.toUpperCase()];

/** Row 1 of the Engineering document: the poll links the same documentId. */
const ENGINEER: UserRow = { id: 5, role: { type: "member" }, department: { id: 1, documentId: "d-eng" } };
const DESIGNER: UserRow = { id: 6, role: { type: "member" }, department: { id: 7, documentId: "d-design" } };
const GUEST: UserRow = { id: 7, role: { type: "guest" }, department: null };
const EDITOR_OUTSIDE: UserRow = { id: 8, role: { type: "editor" }, department: null };
const ADMIN_OUTSIDE: UserRow = { id: 9, role: { type: "admin_role" }, department: { id: 7, documentId: "d-design" } };
const GUEST_ENG: UserRow = { id: 10, role: { type: "guest" }, department: { id: 1, documentId: "d-eng" } };
const FALLBACK: UserRow = { id: 11, role: { type: "authenticated" }, department: null };
const USERS = [ENGINEER, DESIGNER, GUEST, EDITOR_OUTSIDE, ADMIN_OUTSIDE, GUEST_ENG, FALLBACK];

type Where = Record<string, unknown>;

/** Minimal where evaluator: equality and `$notNull`. */
function matches(row: object, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = (row as Record<string, unknown>)[key];
    if (typeof cond === "object" && cond !== null && "$notNull" in cond) {
      return (cond as { $notNull: boolean }).$notNull ? value != null : value == null;
    }
    return String(value) === String(cond);
  });
}

/**
 * A relation key in `where` (every vote query filters on `poll`) makes
 * @strapi/database join the link table, and a joined select without
 * groupBy is SELECT DISTINCT over the selected columns (5.55.1
 * query/query-builder.js shouldUseDistinct). Rows with the same projection
 * collapse into one, as they would in the real query.
 */
function distinctProjection(rows: StoredVoteRow[], select: string[] | undefined): object[] {
  if (!select) return rows;
  const seen = new Set<string>();
  const projected: object[] = [];
  for (const row of rows) {
    const picked = Object.fromEntries(select.map((key) => [key, (row as unknown as Record<string, unknown>)[key]]));
    const key = JSON.stringify(picked);
    if (seen.has(key)) continue;
    seen.add(key);
    projected.push(picked);
  }
  return projected;
}

type Handler = (ctx: unknown) => Promise<unknown>;

/** The id the stub's create gives this request's vote. */
const CREATED_ID = 77;

function setup(options: {
  id: unknown;
  user?: UserRow | null;
  body?: unknown;
  votes?: VoteRow[];
  /**
   * Rows that land while this request runs, after its "Already voted" check
   * and together with its insert: parallel votes. An id below CREATED_ID was
   * inserted first, one above it later.
   */
  concurrent?: StoredVoteRow[];
  /**
   * A parallel vote's cleanup deletes this request's row after create()
   * committed its relation links and before it reads the row back
   * (@strapi/database entity-manager create), so create returns null.
   */
  deletedBeforeReadback?: boolean;
}) {
  const votesTable: StoredVoteRow[] = (options.votes ?? []).map((row, i) => ({ id: 100 + i, ...row }));
  const pollFindOne = vi.fn(async ({ where }: { where: Where }) => {
    failLikePostgres(where);
    return POLLS.find((row) => matches(row, where)) ?? null;
  });
  const votes = {
    findOne: vi.fn(async ({ where }: { where: Where }) =>
      votesTable.find((row) => matches(row, where)) ?? null,
    ),
    findMany: vi.fn(
      async ({ where, select, orderBy }: { where: Where; select?: string[]; orderBy?: { id: "asc" } }) => {
        const found = votesTable.filter((row) => matches(row, where));
        if (orderBy) found.sort((a, b) => a.id - b.id);
        return distinctProjection(found, select);
      },
    ),
    create: vi.fn(async ({ data }: { data: VoteRow }) => {
      votesTable.push({ id: CREATED_ID, ...data }, ...(options.concurrent ?? []));
      if (options.deletedBeforeReadback) {
        votesTable.splice(votesTable.findIndex((row) => row.id === CREATED_ID), 1);
        return null;
      }
      return { id: CREATED_ID, optionIndex: data.optionIndex };
    }),
    delete: vi.fn(async ({ where }: { where: { id: number } }) => {
      const index = votesTable.findIndex((row) => row.id === where.id);
      return index < 0 ? null : votesTable.splice(index, 1)[0];
    }),
    deleteMany: vi.fn(),
  };
  const users = {
    findOne: vi.fn(async ({ where }: { where: { id: number } }) => USERS.find((u) => u.id === where.id) ?? null),
  };
  const strapi = {
    db: {
      query: vi.fn((uid: string) => {
        if (uid === "api::poll.poll") return { findOne: pollFindOne };
        if (uid === "plugin::users-permissions.user") return users;
        return votes;
      }),
    },
  };
  // The results statement, as the reference rule over this table.
  const countBallots = vi.mocked(countPollBallots);
  countBallots.mockReset();
  countBallots.mockImplementation(async (_host, pollId, callerId, optionCount) =>
    tallyBallots(
      votesTable
        .filter((row) => row.poll === pollId)
        .map((row) => ({
          id: row.id,
          optionIndex: row.optionIndex,
          voter: row.voter === null ? null : { id: row.voter },
        })),
      optionCount,
      callerId,
    ),
  );
  const controller = (
    pollVoteController as unknown as (deps: { strapi: unknown }) => {
      vote: Handler;
      results: Handler;
    }
  )({ strapi });
  const user = options.user === undefined ? ENGINEER : options.user;
  const ctx = {
    state: user ? { user: { id: user.id, role: user.role } } : {},
    params: { id: typeof options.id === "number" ? String(options.id) : options.id },
    request: { body: options.body === undefined ? { optionIndex: 0 } : options.body },
    notFound: vi.fn(),
    badRequest: vi.fn(),
    unauthorized: vi.fn(),
    forbidden: vi.fn(),
    send: vi.fn(),
  };
  return { controller, ctx, pollFindOne, votes, votesTable, countBallots };
}

/** The ctx error spies a handler must NOT have touched on the happy path. */
const errorSpies = ["notFound", "badRequest", "unauthorized", "forbidden"] as const;

describe("vote", () => {
  it("answers 401 without a signed-in user", async () => {
    const { controller, ctx, votes } = setup({ id: OPEN.id, user: null });
    await controller.vote(ctx);
    expect(ctx.unauthorized).toHaveBeenCalledWith();
    expect(votes.create).not.toHaveBeenCalled();
  });

  it("requires an integer option index >= 0", async () => {
    for (const body of [{ optionIndex: 1.5 }, { optionIndex: "1" }, { optionIndex: -1 }, { optionIndex: null }, {}, null, "0"]) {
      const { controller, ctx, votes, pollFindOne } = setup({ id: OPEN.id, body });
      await controller.vote(ctx);
      expect(ctx.badRequest, JSON.stringify(body)).toHaveBeenCalledWith("optionIndex required");
      expect(votes.create).not.toHaveBeenCalled();
      expect(pollFindOne).not.toHaveBeenCalled();
    }
  });

  it("answers the same 404 for a missing, malformed, draft and out-of-audience poll", async () => {
    const cases: { id: unknown; user: UserRow }[] = [
      { id: 999, user: ENGINEER },
      { id: "abc", user: ENGINEER },
      { id: "2147483648", user: ENGINEER },
      { id: DRAFT.id, user: ENGINEER },
      // DA01: a documentId nobody has, a draft-only document, the draft
      // twin's row id, and a targeted document outside the audience.
      { id: "k3m9x0000000000000000999", user: ENGINEER },
      { id: DRAFT_ONLY_DOCUMENT_ID, user: ENGINEER },
      { id: TWIN_DRAFT.id, user: ENGINEER },
      { id: ENG_TWIN_DOCUMENT_ID, user: DESIGNER },
      { id: ENG_TWIN_DOCUMENT_ID, user: GUEST_ENG },
      { id: ENG_ONLY.id, user: DESIGNER },
      { id: ENG_ONLY.id, user: GUEST },
      // Guest access: a poll not visible to guests is as missing as any.
      { id: OPEN.id, user: GUEST },
      { id: GUEST_NULL.id, user: GUEST },
      { id: GUEST_VOTE_ONLY.id, user: GUEST },
      { id: ENG_ONLY.id, user: GUEST_ENG },
      { id: ENG_GUESTS.id, user: GUEST },
    ];
    for (const { id, user } of cases) {
      const { controller, ctx, votes } = setup({ id, user });
      await controller.vote(ctx);
      expect(ctx.notFound, `${String(id)} as ${user.id}`).toHaveBeenCalledWith();
      expect(ctx.forbidden).not.toHaveBeenCalled();
      expect(votes.create).not.toHaveBeenCalled();
      expect(ctx.send).not.toHaveBeenCalled();
    }
  });

  it("answers a malformed id with that 404 and no poll query", async () => {
    for (const id of MALFORMED_POLL_IDS) {
      const { controller, ctx, votes, pollFindOne } = setup({ id });
      await controller.vote(ctx);
      expect(ctx.notFound, id).toHaveBeenCalledWith();
      expect(pollFindOne, id).not.toHaveBeenCalled();
      expect(votes.findOne, id).not.toHaveBeenCalled();
      expect(votes.create, id).not.toHaveBeenCalled();
      expect(ctx.send, id).not.toHaveBeenCalled();
    }
  });

  it("pins the poll lookup to published rows", async () => {
    const { controller, ctx, pollFindOne } = setup({ id: DRAFT.id });
    await controller.vote(ctx);
    expect(pollFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DRAFT.id, publishedAt: { $notNull: true } } }),
    );
  });

  it("addresses a poll by documentId and stores the vote on its PUBLISHED row (DA01)", async () => {
    const { controller, ctx, votes, pollFindOne } = setup({
      id: TWIN_DOCUMENT_ID,
      user: ENGINEER,
      body: { optionIndex: 1 },
    });
    await controller.vote(ctx);
    expect(pollFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { documentId: TWIN_DOCUMENT_ID, publishedAt: { $notNull: true } },
      }),
    );
    // Never the draft twin (id 20), whatever row the document has first.
    expect(votes.create).toHaveBeenCalledWith({
      data: { poll: TWIN_PUBLISHED.id, optionIndex: 1, voter: ENGINEER.id },
    });
    expect(votes.findOne).toHaveBeenCalledWith({
      where: { poll: TWIN_PUBLISHED.id, voter: ENGINEER.id },
      select: ["id"],
    });
    for (const spy of errorSpies) expect(ctx[spy], spy).not.toHaveBeenCalled();
  });

  it("refuses a second vote whichever address the first one used", async () => {
    for (const id of [TWIN_DOCUMENT_ID, TWIN_PUBLISHED.id]) {
      const { controller, ctx, votes } = setup({
        id,
        votes: [{ poll: TWIN_PUBLISHED.id, voter: ENGINEER.id, optionIndex: 0 }],
      });
      await controller.vote(ctx);
      expect(ctx.badRequest, String(id)).toHaveBeenCalledWith("Already voted");
      expect(votes.create, String(id)).not.toHaveBeenCalled();
    }
  });

  it("applies the audience rules to a documentId like to a row id", async () => {
    const member = setup({ id: ENG_TWIN_DOCUMENT_ID, user: ENGINEER });
    await member.controller.vote(member.ctx);
    expect(member.votes.create).toHaveBeenCalledWith({
      data: { poll: ENG_TWIN_PUBLISHED.id, optionIndex: 0, voter: ENGINEER.id },
    });
    const editor = setup({ id: ENG_TWIN_DOCUMENT_ID, user: EDITOR_OUTSIDE });
    await editor.controller.vote(editor.ctx);
    expect(editor.ctx.forbidden).toHaveBeenCalledWith("Not in poll audience");
    expect(editor.votes.create).not.toHaveBeenCalled();
  });

  it("answers 403 to admin_role/editor outside the audience (they see it, they do not vote)", async () => {
    for (const user of [EDITOR_OUTSIDE, ADMIN_OUTSIDE]) {
      const { controller, ctx, votes } = setup({ id: ENG_ONLY.id, user });
      await controller.vote(ctx);
      expect(ctx.forbidden, user.role.type).toHaveBeenCalledWith("Not in poll audience");
      expect(ctx.notFound).not.toHaveBeenCalled();
      expect(votes.create).not.toHaveBeenCalled();
    }
  });

  it("rejects an option out of bounds, a closed poll and a second vote", async () => {
    const outOfBounds = setup({ id: OPEN.id, body: { optionIndex: 2 } });
    await outOfBounds.controller.vote(outOfBounds.ctx);
    expect(outOfBounds.ctx.badRequest).toHaveBeenCalledWith("Invalid optionIndex");

    const closed = setup({ id: CLOSED.id });
    await closed.controller.vote(closed.ctx);
    expect(closed.ctx.badRequest).toHaveBeenCalledWith("Poll is closed");

    const again = setup({ id: OPEN.id, votes: [{ poll: OPEN.id, voter: ENGINEER.id, optionIndex: 1 }] });
    await again.controller.vote(again.ctx);
    expect(again.ctx.badRequest).toHaveBeenCalledWith("Already voted");
    expect(again.votes.findOne).toHaveBeenCalledWith({
      where: { poll: OPEN.id, voter: ENGINEER.id },
      select: ["id"],
    });

    for (const { votes } of [outOfBounds, closed, again]) expect(votes.create).not.toHaveBeenCalled();
  });

  it('refuses a vote whose shown option is no longer at its index ("Poll options changed")', async () => {
    // OPEN's options are ["yes", "no"]; the cards rendered before an admin
    // edit showed them reordered (["no", "yes"]) or with one replaced
    // (["yes", "maybe"]). Both addresses resolve to the current options.
    const cases: { id: unknown; body: { optionIndex: number; option: string } }[] = [
      { id: OPEN.id, body: { optionIndex: 0, option: "no" } },
      { id: OPEN.id, body: { optionIndex: 1, option: "yes" } },
      { id: OPEN.id, body: { optionIndex: 1, option: "maybe" } },
      { id: TWIN_DOCUMENT_ID, body: { optionIndex: 0, option: "no" } },
    ];
    for (const { id, body } of cases) {
      const { controller, ctx, votes } = setup({ id, body });
      await controller.vote(ctx);
      const label = `${String(id)} ${JSON.stringify(body)}`;
      expect(ctx.badRequest, label).toHaveBeenCalledWith("Poll options changed");
      expect(votes.findOne, label).not.toHaveBeenCalled();
      expect(votes.create, label).not.toHaveBeenCalled();
      expect(ctx.send, label).not.toHaveBeenCalled();
    }
  });

  it("records the vote after a republish that kept the shown option at its index (DA01)", async () => {
    const { controller, ctx, votes } = setup({
      id: TWIN_DOCUMENT_ID,
      body: { optionIndex: 1, option: "no" },
    });
    await controller.vote(ctx);
    expect(votes.create).toHaveBeenCalledWith({
      data: { poll: TWIN_PUBLISHED.id, optionIndex: 1, voter: ENGINEER.id },
    });
    for (const spy of errorSpies) expect(ctx[spy], spy).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalledOnce();
  });

  it("does not compare a body without a string option (a web from before the check)", async () => {
    for (const body of [
      { optionIndex: 1 },
      { optionIndex: 1, option: null },
      { optionIndex: 1, option: 0 },
    ]) {
      const { controller, ctx, votes } = setup({ id: OPEN.id, body });
      await controller.vote(ctx);
      expect(votes.create, JSON.stringify(body)).toHaveBeenCalledWith({
        data: { poll: OPEN.id, optionIndex: 1, voter: ENGINEER.id },
      });
      for (const spy of errorSpies) expect(ctx[spy], spy).not.toHaveBeenCalled();
    }
  });

  it("checks the shown option only after the audience and bounds checks", async () => {
    const outside = setup({
      id: ENG_ONLY.id,
      user: DESIGNER,
      body: { optionIndex: 0, option: "stale" },
    });
    await outside.controller.vote(outside.ctx);
    expect(outside.ctx.notFound).toHaveBeenCalledWith();
    expect(outside.ctx.badRequest).not.toHaveBeenCalled();

    const outOfBounds = setup({ id: OPEN.id, body: { optionIndex: 2, option: "maybe" } });
    await outOfBounds.controller.vote(outOfBounds.ctx);
    expect(outOfBounds.ctx.badRequest).toHaveBeenCalledWith("Invalid optionIndex");
    expect(outOfBounds.ctx.badRequest).toHaveBeenCalledOnce();
  });

  it("records a member's vote in the audience with the caller as voter, ignoring body poll/voter", async () => {
    const { controller, ctx, votes } = setup({
      id: ENG_ONLY.id,
      user: ENGINEER,
      body: { optionIndex: 1, poll: OPEN.id, voter: 1 },
    });
    await controller.vote(ctx);
    expect(votes.create).toHaveBeenCalledWith({
      data: { poll: ENG_ONLY.id, optionIndex: 1, voter: ENGINEER.id },
    });
    for (const spy of errorSpies) expect(ctx[spy], spy).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalledOnce();
  });

  it("answers 403 to a guest on a poll visible to guests without guest voting", async () => {
    for (const [id, user] of [
      [GUEST_VISIBLE.id, GUEST],
      [GUEST_VISIBLE.id, GUEST_ENG],
      [ENG_GUESTS_READ.id, GUEST_ENG],
    ] as const) {
      const { controller, ctx, votes } = setup({ id, user });
      await controller.vote(ctx);
      expect(ctx.forbidden, `${id} as ${user.id}`).toHaveBeenCalledWith("Guests cannot vote on this poll");
      expect(ctx.notFound).not.toHaveBeenCalled();
      expect(votes.create).not.toHaveBeenCalled();
    }
  });

  it("records a guest's vote where guests may vote (company-wide, and the guest's own department)", async () => {
    const companyWide = setup({ id: GUEST_VOTABLE.id, user: GUEST });
    await companyWide.controller.vote(companyWide.ctx);
    expect(companyWide.votes.create).toHaveBeenCalledWith({
      data: { poll: GUEST_VOTABLE.id, optionIndex: 0, voter: GUEST.id },
    });
    for (const spy of errorSpies) expect(companyWide.ctx[spy], spy).not.toHaveBeenCalled();

    const ownDepartment = setup({ id: ENG_GUESTS.id, user: GUEST_ENG, body: { optionIndex: 1 } });
    await ownDepartment.controller.vote(ownDepartment.ctx);
    expect(ownDepartment.votes.create).toHaveBeenCalledWith({
      data: { poll: ENG_GUESTS.id, optionIndex: 1, voter: GUEST_ENG.id },
    });
  });

  it("keeps the other vote rules for a guest who may vote (second vote refused)", async () => {
    const again = setup({
      id: GUEST_VOTABLE.id,
      user: GUEST,
      votes: [{ poll: GUEST_VOTABLE.id, voter: GUEST.id, optionIndex: 0 }],
    });
    await again.controller.vote(again.ctx);
    expect(again.ctx.badRequest).toHaveBeenCalledWith("Already voted");
    expect(again.votes.create).not.toHaveBeenCalled();
  });

  it("lets every non-guest vote whatever the guest flags say", async () => {
    for (const poll of [OPEN, GUEST_VISIBLE, GUEST_VOTE_ONLY, GUEST_NULL]) {
      for (const user of [ENGINEER, DESIGNER, FALLBACK, EDITOR_OUTSIDE]) {
        const { controller, ctx, votes } = setup({ id: poll.id, user });
        await controller.vote(ctx);
        expect(votes.create, `${poll.documentId} as ${user.role.type}`).toHaveBeenCalledOnce();
      }
    }
  });

  it("lets admin_role/editor vote on a company-wide poll", async () => {
    const { controller, ctx, votes } = setup({ id: OPEN.id, user: EDITOR_OUTSIDE });
    await controller.vote(ctx);
    expect(votes.create).toHaveBeenCalledOnce();
  });
});

describe("vote: one ballot per voter after a parallel race", () => {
  const ballotsOf = (table: StoredVoteRow[], poll: number, voter: number) =>
    table.filter((row) => row.poll === poll && row.voter === voter).map((row) => row.id);

  it("looks for the voter's rows of this poll after the insert and deletes nothing when it is the only one", async () => {
    const { controller, ctx, votes, votesTable } = setup({ id: OPEN.id, user: ENGINEER });
    await controller.vote(ctx);
    expect(votes.findMany).toHaveBeenCalledWith({
      where: { poll: OPEN.id, voter: ENGINEER.id },
      select: ["id"],
      orderBy: { id: "asc" },
    });
    expect(votes.create.mock.invocationCallOrder[0]).toBeLessThan(
      votes.findMany.mock.invocationCallOrder[0] ?? 0,
    );
    expect(votes.delete).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalledWith({ data: { id: CREATED_ID, optionIndex: 0 } });
    expect(ballotsOf(votesTable, OPEN.id, ENGINEER.id)).toEqual([CREATED_ID]);
  });

  it("deletes the voter's later ballots and answers with its own, the first", async () => {
    const { controller, ctx, votes, votesTable } = setup({
      id: OPEN.id,
      user: ENGINEER,
      concurrent: [
        { id: CREATED_ID + 3, poll: OPEN.id, voter: ENGINEER.id, optionIndex: 1 },
        { id: CREATED_ID + 5, poll: OPEN.id, voter: ENGINEER.id, optionIndex: 0 },
      ],
    });
    await controller.vote(ctx);
    expect(votes.delete.mock.calls.map(([params]) => params)).toEqual([
      { where: { id: CREATED_ID + 3 } },
      { where: { id: CREATED_ID + 5 } },
    ]);
    // Row by row through the entity manager, so the link rows go too.
    expect(votes.deleteMany).not.toHaveBeenCalled();
    for (const spy of errorSpies) expect(ctx[spy], spy).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalledWith({ data: { id: CREATED_ID, optionIndex: 0 } });
    expect(ballotsOf(votesTable, OPEN.id, ENGINEER.id)).toEqual([CREATED_ID]);
  });

  it('deletes its own ballot and answers "Already voted" when an earlier one landed first', async () => {
    const { controller, ctx, votes, votesTable } = setup({
      id: OPEN.id,
      user: ENGINEER,
      body: { optionIndex: 0 },
      concurrent: [{ id: CREATED_ID - 7, poll: OPEN.id, voter: ENGINEER.id, optionIndex: 1 }],
    });
    await controller.vote(ctx);
    expect(votes.delete).toHaveBeenCalledOnce();
    expect(votes.delete).toHaveBeenCalledWith({ where: { id: CREATED_ID } });
    expect(ctx.badRequest).toHaveBeenCalledWith("Already voted");
    expect(ctx.send).not.toHaveBeenCalled();
    // The first ballot (option 1) is the one that stays and counts.
    expect(ballotsOf(votesTable, OPEN.id, ENGINEER.id)).toEqual([CREATED_ID - 7]);
  });

  it('answers "Already voted" when a parallel cleanup deleted its ballot before create read it back', async () => {
    const { controller, ctx, votes, votesTable } = setup({
      id: OPEN.id,
      user: ENGINEER,
      body: { optionIndex: 0 },
      concurrent: [
        { id: CREATED_ID - 7, poll: OPEN.id, voter: ENGINEER.id, optionIndex: 1 },
        { id: CREATED_ID + 2, poll: OPEN.id, voter: ENGINEER.id, optionIndex: 0 },
      ],
      deletedBeforeReadback: true,
    });
    // No TypeError from the missing row: the 400 a second vote gets.
    await expect(controller.vote(ctx)).resolves.toBeUndefined();
    expect(ctx.badRequest).toHaveBeenCalledWith("Already voted");
    expect(ctx.send).not.toHaveBeenCalled();
    // The cleanup still runs: the later ballot goes, the missing one is not
    // deleted again, and the first ballot stays.
    expect(votes.delete.mock.calls.map(([params]) => params)).toEqual([
      { where: { id: CREATED_ID + 2 } },
    ]);
    expect(ballotsOf(votesTable, OPEN.id, ENGINEER.id)).toEqual([CREATED_ID - 7]);
  });

  it("never touches other voters' ballots or the voter's ballots on other polls", async () => {
    const { controller, ctx, votes, votesTable } = setup({
      id: OPEN.id,
      user: ENGINEER,
      concurrent: [
        { id: CREATED_ID - 1, poll: OPEN.id, voter: DESIGNER.id, optionIndex: 1 },
        { id: CREATED_ID + 1, poll: OPEN.id, voter: DESIGNER.id, optionIndex: 1 },
        { id: CREATED_ID - 2, poll: CLOSING.id, voter: ENGINEER.id, optionIndex: 0 },
      ],
    });
    await controller.vote(ctx);
    expect(votes.delete).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalledOnce();
    expect(votesTable.map((row) => row.id).sort((a, b) => a - b)).toEqual([
      CREATED_ID - 2,
      CREATED_ID - 1,
      CREATED_ID,
      CREATED_ID + 1,
    ]);
  });
});

describe("vote: close rule (datetime contract)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a vote until the instant before closesAt", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-30T21:59:58.999Z") });
    const { controller, ctx, votes } = setup({ id: CLOSING.id });
    await controller.vote(ctx);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(votes.create).toHaveBeenCalledOnce();
  });

  it("is closed at exactly closesAt (now >= closesAt), like the web", async () => {
    vi.useFakeTimers({ now: new Date(CLOSING.closesAt as string) });
    const { controller, ctx, votes } = setup({ id: CLOSING.id });
    await controller.vote(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith("Poll is closed");
    expect(votes.create).not.toHaveBeenCalled();
  });
});

describe("results", () => {
  const sent = (ctx: { send: ReturnType<typeof vi.fn> }) => ctx.send.mock.calls[0]?.[0] as Record<string, unknown>;

  it("answers 401 without a signed-in user", async () => {
    const { controller, ctx, votes, countBallots } = setup({ id: OPEN.id, user: null });
    await controller.results(ctx);
    expect(ctx.unauthorized).toHaveBeenCalledWith();
    expect(votes.findMany).not.toHaveBeenCalled();
    expect(countBallots).not.toHaveBeenCalled();
  });

  it("answers the same 404 for a missing, malformed, draft and out-of-audience poll", async () => {
    const cases: { id: unknown; user: UserRow }[] = [
      { id: 999, user: ENGINEER },
      { id: "abc", user: ENGINEER },
      { id: DRAFT.id, user: ENGINEER },
      { id: "k3m9x0000000000000000999", user: ENGINEER },
      { id: DRAFT_ONLY_DOCUMENT_ID, user: ENGINEER },
      { id: TWIN_DRAFT.id, user: ENGINEER },
      { id: ENG_TWIN_DOCUMENT_ID, user: DESIGNER },
      { id: ENG_ONLY.id, user: DESIGNER },
      { id: ENG_ONLY.id, user: GUEST },
      // Guest access: question, options and counts of a poll not visible
      // to guests never reach a guest.
      { id: OPEN.id, user: GUEST },
      { id: GUEST_NULL.id, user: GUEST },
      { id: GUEST_VOTE_ONLY.id, user: GUEST },
      { id: ENG_ONLY.id, user: GUEST_ENG },
      { id: ENG_GUESTS.id, user: GUEST },
    ];
    for (const { id, user } of cases) {
      const { controller, ctx, votes, countBallots } = setup({ id, user });
      await controller.results(ctx);
      expect(ctx.notFound, `${String(id)} as ${user.id}`).toHaveBeenCalledWith();
      expect(votes.findMany).not.toHaveBeenCalled();
      expect(countBallots).not.toHaveBeenCalled();
      expect(ctx.send).not.toHaveBeenCalled();
    }
  });

  it("answers a malformed id with that 404 and no poll query", async () => {
    for (const id of MALFORMED_POLL_IDS) {
      const { controller, ctx, votes, pollFindOne, countBallots } = setup({ id });
      await controller.results(ctx);
      expect(ctx.notFound, id).toHaveBeenCalledWith();
      expect(pollFindOne, id).not.toHaveBeenCalled();
      expect(countBallots, id).not.toHaveBeenCalled();
      expect(votes.findMany, id).not.toHaveBeenCalled();
      expect(votes.findOne, id).not.toHaveBeenCalled();
      expect(ctx.send, id).not.toHaveBeenCalled();
    }
  });

  it("pins the poll lookup to published rows", async () => {
    const { controller, ctx, pollFindOne } = setup({ id: DRAFT.id });
    await controller.results(ctx);
    expect(pollFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DRAFT.id, publishedAt: { $notNull: true } } }),
    );
  });

  it("counts every vote of the published row and totals them", async () => {
    const { controller, ctx, votes, countBallots } = setup({
      id: OPEN.id,
      votes: [
        { poll: OPEN.id, voter: 11, optionIndex: 1 },
        { poll: OPEN.id, voter: 12, optionIndex: 1 },
        { poll: OPEN.id, voter: 13, optionIndex: 0 },
        { poll: CLOSING.id, voter: 14, optionIndex: 0 },
      ],
    });
    await controller.results(ctx);
    expect(sent(ctx)).toEqual({
      poll: {
        id: OPEN.id,
        // The poll's address (DA01), since the body is shared with the
        // batched GET /api/poll-results (WD04).
        documentId: OPEN.documentId,
        question: OPEN.question,
        options: OPEN.options,
        closesAt: null,
        anonymous: false,
        visibleToGuests: false,
        guestsCanVote: false,
      },
      counts: [1, 2],
      total: 3,
      myVoteIndex: null,
      canVote: true,
      audience: { targeted: false, departments: [] },
    });
    // One statement for the counts and the caller's own vote (FX20): the
    // published row's id, the caller, the number of options.
    expect(countBallots).toHaveBeenCalledOnce();
    expect(countBallots.mock.calls[0]?.slice(1)).toEqual([OPEN.id, ENGINEER.id, 2]);
    expect(votes.findMany).not.toHaveBeenCalled();
    expect(votes.findOne).not.toHaveBeenCalled();
  });

  it("gives the same results for the documentId and the published row id, counting the published row (DA01)", async () => {
    const votes: VoteRow[] = [
      { poll: TWIN_PUBLISHED.id, voter: 11, optionIndex: 1 },
      { poll: TWIN_PUBLISHED.id, voter: ENGINEER.id, optionIndex: 0 },
      // A row pointing at the draft twin never counts (the vote handler
      // only ever stores the published row's id).
      { poll: TWIN_DRAFT.id, voter: 12, optionIndex: 1 },
    ];
    const bodies: Record<string, unknown>[] = [];
    for (const id of [TWIN_DOCUMENT_ID, TWIN_PUBLISHED.id]) {
      const { controller, ctx, pollFindOne } = setup({ id, user: ENGINEER, votes });
      await controller.results(ctx);
      expect(pollFindOne, String(id)).toHaveBeenCalledWith(
        expect.objectContaining({
          where:
            id === TWIN_DOCUMENT_ID
              ? { documentId: TWIN_DOCUMENT_ID, publishedAt: { $notNull: true } }
              : { id: TWIN_PUBLISHED.id, publishedAt: { $notNull: true } },
        }),
      );
      bodies.push(sent(ctx));
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toMatchObject({
      poll: { id: TWIN_PUBLISHED.id, question: "Twin" },
      counts: [1, 1],
      total: 2,
      myVoteIndex: 0,
    });
  });

  it("counts one ballot per voter: the first stored ballot (lowest id) wins, also for the caller", async () => {
    // Rows get ids 100, 101, ... in this order: the caller's first ballot is
    // option 0, a parallel duplicate of it option 1.
    const { controller, ctx } = setup({
      id: OPEN.id,
      user: ENGINEER,
      votes: [
        { poll: OPEN.id, voter: ENGINEER.id, optionIndex: 0 },
        { poll: OPEN.id, voter: 12, optionIndex: 1 },
        { poll: OPEN.id, voter: ENGINEER.id, optionIndex: 1 },
        { poll: OPEN.id, voter: 12, optionIndex: 0 },
        { poll: OPEN.id, voter: ENGINEER.id, optionIndex: 1 },
        { poll: OPEN.id, voter: 13, optionIndex: 1 },
      ],
    });
    await controller.results(ctx);
    expect(sent(ctx)).toMatchObject({ counts: [1, 2], total: 3, myVoteIndex: 0 });
  });

  it("counts each vote of a deleted account on its own", async () => {
    const { controller, ctx } = setup({
      id: OPEN.id,
      votes: [
        { poll: OPEN.id, voter: null, optionIndex: 1 },
        { poll: OPEN.id, voter: null, optionIndex: 1 },
        { poll: OPEN.id, voter: 12, optionIndex: 0 },
      ],
    });
    await controller.results(ctx);
    expect(sent(ctx)).toMatchObject({ counts: [1, 2], total: 3, myVoteIndex: null });
  });

  it("counts identical votes one by one", async () => {
    // The DISTINCT trap (0bc7830) is pinned on the real engines in
    // poll-ballots.engine.test.ts; the statement counts `v.id`.
    const { controller, ctx } = setup({
      id: OPEN.id,
      votes: [11, 12, 13, 14, 15, 16].map((voter) => ({ poll: OPEN.id, voter, optionIndex: 1 })),
    });
    await controller.results(ctx);
    expect(sent(ctx)).toMatchObject({ counts: [0, 6], total: 6 });
  });

  it("counts the published row of a documentId, whose options set the count's length (DA01, FX20)", async () => {
    const { controller, ctx, countBallots } = setup({ id: TWIN_DOCUMENT_ID, user: DESIGNER });
    await controller.results(ctx);
    expect(countBallots.mock.calls.map((call) => call.slice(1))).toEqual([
      [TWIN_PUBLISHED.id, DESIGNER.id, TWIN_PUBLISHED.options.length],
    ]);
  });

  it("gives admin_role/editor outside the audience the results with canVote false and the departments", async () => {
    for (const user of [ADMIN_OUTSIDE, EDITOR_OUTSIDE]) {
      const { controller, ctx } = setup({ id: ENG_ONLY.id, user });
      await controller.results(ctx);
      expect(ctx.notFound, user.role.type).not.toHaveBeenCalled();
      expect(sent(ctx)).toMatchObject({
        canVote: false,
        audience: { targeted: true, departments: [{ documentId: "d-eng", name: "Engineering" }] },
      });
    }
  });

  it("gives a member of the audience canVote true on a targeted poll", async () => {
    const { controller, ctx } = setup({ id: ENG_ONLY.id, user: ENGINEER });
    await controller.results(ctx);
    expect(sent(ctx)).toMatchObject({ canVote: true, audience: { targeted: true } });
  });

  it("returns the caller's own vote on an anonymous poll, and no voter anywhere", async () => {
    const { controller, ctx, votes } = setup({
      id: ENG_ONLY.id,
      user: ENGINEER,
      votes: [
        { poll: ENG_ONLY.id, voter: 42, optionIndex: 0 },
        { poll: ENG_ONLY.id, voter: ENGINEER.id, optionIndex: 1 },
      ],
    });
    await controller.results(ctx);
    const body = sent(ctx);
    expect(body.myVoteIndex).toBe(1);
    expect((body.poll as { anonymous: boolean }).anonymous).toBe(true);
    expect(JSON.stringify(body)).not.toContain("voter");
    // No voter is loaded at all: the statement counts in the database.
    expect(votes.findMany).not.toHaveBeenCalled();
  });

  it("gives a guest a visible poll's results with canVote false when guests may not vote", async () => {
    for (const [poll, user] of [
      [GUEST_VISIBLE, GUEST],
      [ENG_GUESTS_READ, GUEST_ENG],
    ] as const) {
      const { controller, ctx } = setup({
        id: poll.id,
        user,
        votes: [{ poll: poll.id, voter: 42, optionIndex: 1 }],
      });
      await controller.results(ctx);
      expect(ctx.notFound, poll.documentId).not.toHaveBeenCalled();
      expect(sent(ctx), poll.documentId).toMatchObject({
        poll: { id: poll.id, question: poll.question, visibleToGuests: true, guestsCanVote: false },
        counts: [0, 1],
        total: 1,
        canVote: false,
      });
    }
  });

  it("gives a guest canVote true where guests may vote", async () => {
    for (const [poll, user] of [
      [GUEST_VOTABLE, GUEST],
      [ENG_GUESTS, GUEST_ENG],
    ] as const) {
      const { controller, ctx } = setup({ id: poll.id, user });
      await controller.results(ctx);
      expect(sent(ctx), poll.documentId).toMatchObject({
        poll: { visibleToGuests: true, guestsCanVote: true },
        canVote: true,
      });
    }
  });

  it("reports the stored guest flags as strict booleans to every reader (NULL = false)", async () => {
    const cases: [PollRow, UserRow, { visibleToGuests: boolean; guestsCanVote: boolean }][] = [
      [GUEST_NULL, ENGINEER, { visibleToGuests: false, guestsCanVote: false }],
      [GUEST_VOTE_ONLY, EDITOR_OUTSIDE, { visibleToGuests: false, guestsCanVote: true }],
      [GUEST_VOTABLE, ADMIN_OUTSIDE, { visibleToGuests: true, guestsCanVote: true }],
    ];
    for (const [poll, user, flags] of cases) {
      const { controller, ctx } = setup({ id: poll.id, user });
      await controller.results(ctx);
      const body = sent(ctx);
      expect(body.poll, poll.documentId).toMatchObject(flags);
      // Non-guests: the flags change nothing about voting.
      expect(body.canVote, poll.documentId).toBe(true);
    }
  });

  it("keeps canVote for the `authenticated` fallback and members on polls hidden from guests", async () => {
    for (const user of [FALLBACK, ENGINEER, DESIGNER]) {
      const { controller, ctx } = setup({ id: OPEN.id, user });
      await controller.results(ctx);
      expect(sent(ctx), user.role.type).toMatchObject({ canVote: true, poll: { visibleToGuests: false } });
    }
  });
});
