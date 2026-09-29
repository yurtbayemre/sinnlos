import { beforeEach, describe, expect, it, vi } from "vitest";

import { MALFORMED_ENTRY_IDS, failLikePostgres } from "../../../utils/entry-id.test.helper";
import {
  countPollBallots,
  countPollBallotsMany,
  tallyBallots,
  type BallotRow,
} from "../../../utils/poll-ballots";
import pollVoteController from "../../poll-vote/controllers/poll-vote";
import pollController from "./poll";

/**
 * POST /api/polls pins the author to the caller (FX20, §5.21): a
 * client-sent author is overwritten, a missing one is filled in. The core
 * create is a prototype spy, where createCoreController puts the base
 * controller.
 *
 * GET /api/poll-results (WD04, batchResults) is pinned against the single
 * GET /api/polls/:id/results (the real poll-vote controller on the same
 * stub): for every caller and every address, a poll is in the batch
 * exactly when the single read answers it, with the identical body; the
 * rest is absent (no existence oracle). The counting statements are
 * replaced by the reference rule (tallyBallots), which
 * utils/poll-ballots.engine.test.ts holds equal to both statements.
 */

const mocks = vi.hoisted(() => ({
  superCreate: vi.fn(async (_ctx: unknown) => ({ data: { id: 1 } })),
}));

vi.mock("../../../utils/poll-ballots", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/poll-ballots")>()),
  countPollBallots: vi.fn(),
  countPollBallotsMany: vi.fn(),
}));

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        Object.setPrototypeOf(cfg({ strapi }), { create: mocks.superCreate }),
  },
}));

const EDITOR = { id: 7, role: { type: "editor" } };

interface Ctx {
  state: { user?: typeof EDITOR };
  request: { body: unknown };
  unauthorized: ReturnType<typeof vi.fn>;
}

function setup(body: unknown, user: typeof EDITOR | null = EDITOR) {
  const controller = (
    pollController as unknown as (deps: { strapi: unknown }) => {
      create(ctx: Ctx): Promise<unknown>;
    }
  )({ strapi: {} });
  const ctx: Ctx = {
    state: { user: user ?? undefined },
    request: { body },
    unauthorized: vi.fn(() => ({ status: 401 })),
  };
  return { controller, ctx };
}

beforeEach(() => {
  mocks.superCreate.mockClear();
});

describe("poll create: server-authoritative author (FX20)", () => {
  const data = { question: "Lunch?", options: ["Mon", "Tue"], audience: "all" };

  it("overwrites a client-sent author with the caller", async () => {
    for (const author of [99, "99", { id: 99 }, { connect: [{ id: 99 }] }, null]) {
      const { controller, ctx } = setup({ data: { ...data, author } });
      await controller.create(ctx);
      expect(ctx.request.body).toEqual({ data: { ...data, author: EDITOR.id } });
    }
    expect(mocks.superCreate).toHaveBeenCalledTimes(5);
  });

  it("fills in the author when the payload has none (the web's createPoll)", async () => {
    const { controller, ctx } = setup({ data });
    await controller.create(ctx);
    expect(ctx.request.body).toEqual({ data: { ...data, author: EDITOR.id } });
    expect(mocks.superCreate).toHaveBeenCalledWith(ctx);
  });

  it("keeps other body keys and leaves the caller's payload object unchanged", async () => {
    const original = { ...data, author: 99 };
    const { controller, ctx } = setup({ data: original, extra: 1 });
    await controller.create(ctx);
    expect(ctx.request.body).toEqual({ data: { ...data, author: EDITOR.id }, extra: 1 });
    expect(original.author).toBe(99);
  });

  it("hands a body without a data object to the core create unchanged", async () => {
    for (const body of [undefined, null, {}, { data: "x" }, { data: [1] }, "text"]) {
      const { controller, ctx } = setup(body);
      await controller.create(ctx);
      expect(ctx.request.body).toBe(body);
    }
  });

  it("answers 401 without a user and never reaches the core create", async () => {
    const { controller, ctx } = setup({ data }, null);
    await controller.create(ctx);
    expect(ctx.unauthorized).toHaveBeenCalled();
    expect(mocks.superCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/poll-results (WD04)
// ---------------------------------------------------------------------------

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

interface UserRow {
  id: number;
  role: { type: string };
  department: { id: number; documentId: string } | null;
}

interface VoteRow {
  id: number;
  poll: number;
  voter: number | null;
  optionIndex: number;
}

const PUBLISHED_AT = "2026-09-01T00:00:00.000Z";
const docId = (n: number) => `k3m9x${String(n).padStart(19, "0")}`;
const base = (id: number, extra: Partial<PollRow> = {}): PollRow => ({
  id,
  documentId: docId(id),
  question: `Poll ${id}`,
  options: ["a", "b", "c"],
  closesAt: null,
  anonymous: false,
  audience: "all",
  departments: [],
  publishedAt: PUBLISHED_AT,
  visibleToGuests: false,
  guestsCanVote: false,
  ...extra,
});

const ENG = { documentId: "d-eng", name: "Engineering" };
/** A company-wide poll with its draft twin (lower id), addressed by documentId. */
const OPEN_DRAFT = base(1, { documentId: docId(2), publishedAt: null, question: "Open (draft)" });
const OPEN = base(2);
const ENG_ONLY = base(3, { audience: "departments", departments: [ENG], anonymous: true });
const GUEST_READ = base(4, { visibleToGuests: true });
const GUEST_VOTE = base(5, { visibleToGuests: true, guestsCanVote: true });
const LEGACY = base(6, { audience: null, visibleToGuests: null, guestsCanVote: null });
const DRAFT_ONLY = base(7, { publishedAt: null });
const ENG_GUESTS = base(8, {
  audience: "departments",
  departments: [ENG],
  visibleToGuests: true,
  guestsCanVote: true,
});
const BROKEN_OPTIONS = { ...base(9), options: "not a list" as unknown as string[] };
const POLLS: PollRow[] = [
  OPEN_DRAFT,
  OPEN,
  ENG_ONLY,
  GUEST_READ,
  GUEST_VOTE,
  LEGACY,
  DRAFT_ONLY,
  ENG_GUESTS,
  BROKEN_OPTIONS,
];

const ENGINEER: UserRow = { id: 11, role: { type: "member" }, department: { id: 1, documentId: "d-eng" } };
const DESIGNER: UserRow = { id: 12, role: { type: "member" }, department: { id: 7, documentId: "d-design" } };
const GUEST: UserRow = { id: 13, role: { type: "guest" }, department: null };
const GUEST_ENG: UserRow = { id: 14, role: { type: "guest" }, department: { id: 1, documentId: "d-eng" } };
const EDITOR_USER: UserRow = { id: 15, role: { type: "editor" }, department: null };
const ADMIN: UserRow = { id: 16, role: { type: "admin_role" }, department: null };
const FALLBACK: UserRow = { id: 17, role: { type: "authenticated" }, department: null };
const USERS = [ENGINEER, DESIGNER, GUEST, GUEST_ENG, EDITOR_USER, ADMIN, FALLBACK];

const VOTES: VoteRow[] = [
  { id: 100, poll: OPEN.id, voter: ENGINEER.id, optionIndex: 1 },
  { id: 101, poll: OPEN.id, voter: DESIGNER.id, optionIndex: 1 },
  // A later duplicate of the same voter: never counted.
  { id: 102, poll: OPEN.id, voter: ENGINEER.id, optionIndex: 0 },
  { id: 103, poll: ENG_ONLY.id, voter: ENGINEER.id, optionIndex: 2 },
  { id: 104, poll: GUEST_VOTE.id, voter: GUEST.id, optionIndex: 0 },
  // A vote of a deleted account.
  { id: 105, poll: LEGACY.id, voter: null, optionIndex: 2 },
  // A vote on the draft twin: never counted (only published rows are read).
  { id: 106, poll: OPEN_DRAFT.id, voter: DESIGNER.id, optionIndex: 2 },
];

type Where = Record<string, unknown>;

/** The where evaluator the loaders need: equality, $notNull, $in and $or. */
function passes(row: object, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "$or") return (cond as Where[]).some((branch) => passes(row, branch));
    const value = (row as Record<string, unknown>)[key];
    if (typeof cond === "object" && cond !== null && "$notNull" in cond) {
      return (cond as { $notNull: boolean }).$notNull ? value != null : value == null;
    }
    if (typeof cond === "object" && cond !== null && "$in" in cond) {
      return (cond as { $in: unknown[] }).$in.some((item) => String(item) === String(value));
    }
    return String(value) === String(cond);
  });
}

const ballotRows = (pollId: number): BallotRow[] =>
  VOTES.filter((vote) => vote.poll === pollId).map((vote) => ({
    id: vote.id,
    optionIndex: vote.optionIndex,
    voter: vote.voter === null ? null : { id: vote.voter },
  }));

interface BatchCtx {
  state: { user?: UserRow };
  params: { id?: unknown };
  query: { ids?: unknown };
  body?: unknown;
  status?: number;
  send(body: unknown): void;
  unauthorized(): void;
  notFound(): void;
  badRequest(message: string): void;
}

function batchSetup() {
  const pollFindMany = vi.fn(async ({ where }: { where: Where }) =>
    POLLS.filter((row) => passes(row, where)),
  );
  const pollFindOne = vi.fn(async ({ where }: { where: Where }) => {
    failLikePostgres(where);
    return POLLS.find((row) => passes(row, where)) ?? null;
  });
  const users = {
    findOne: vi.fn(
      async ({ where }: { where: { id: number } }) => USERS.find((u) => u.id === where.id) ?? null,
    ),
  };
  const strapi = {
    db: {
      query: vi.fn((uid: string) => {
        if (uid === "api::poll.poll") return { findOne: pollFindOne, findMany: pollFindMany };
        if (uid === "plugin::users-permissions.user") return users;
        throw new Error(`unexpected query on ${uid}`);
      }),
    },
  };
  const many = vi.mocked(countPollBallotsMany);
  many.mockReset();
  many.mockImplementation(async (_host, polls, callerId) => {
    const tallies = new Map<number, ReturnType<typeof tallyBallots>>();
    for (const poll of polls) {
      tallies.set(poll.id, tallyBallots(ballotRows(poll.id), poll.optionCount, callerId));
    }
    return tallies;
  });
  const single = vi.mocked(countPollBallots);
  single.mockReset();
  single.mockImplementation(async (_host, pollId, callerId, optionCount) =>
    tallyBallots(ballotRows(pollId), optionCount, callerId),
  );
  type Handlers = Record<string, (ctx: BatchCtx) => Promise<unknown>>;
  const polls = (pollController as unknown as (deps: { strapi: unknown }) => Handlers)({ strapi });
  const votes = (pollVoteController as unknown as (deps: { strapi: unknown }) => Handlers)({
    strapi,
  });
  return { polls, votes, pollFindMany, pollFindOne, many };
}

function context(user: UserRow | null, init: { ids?: unknown; id?: unknown } = {}): BatchCtx {
  const ctx: BatchCtx = {
    state: { user: user ?? undefined },
    params: { id: init.id },
    query: { ids: init.ids },
    send(body) {
      ctx.status = 200;
      ctx.body = body;
    },
    unauthorized() {
      ctx.status = 401;
    },
    notFound() {
      ctx.status = 404;
    },
    badRequest(message) {
      ctx.status = 400;
      ctx.body = { error: message };
    },
  };
  return ctx;
}

/** The addresses of every poll row: documentId and row id, drafts and a missing one. */
const ADDRESSES = [
  ...POLLS.flatMap((poll) => [poll.documentId, String(poll.id)]),
  docId(999),
  "999",
];

describe("GET /api/poll-results (WD04)", () => {
  it("answers 401 without a user", async () => {
    const { polls, pollFindMany } = batchSetup();
    const ctx = context(null, { ids: docId(2) });
    await polls.batchResults(ctx);
    expect(ctx.status).toBe(401);
    expect(pollFindMany).not.toHaveBeenCalled();
  });

  const REFUSED: [name: string, ids: unknown, message: string][] = [
    ["no ids", undefined, "ids required"],
    ["an empty list", "", "Invalid ids"],
    ["a trailing comma", `${docId(2)},`, "Invalid ids"],
    ["a non-string", { $ne: 1 }, "Invalid ids"],
    ["51 polls", Array.from({ length: 51 }, (_, i) => String(i + 1)).join(","), "At most 50 ids"],
    ...MALFORMED_ENTRY_IDS.map((id): [string, unknown, string] => [
      `the malformed id ${JSON.stringify(id)}`,
      `${docId(2)},${id}`,
      "Invalid ids",
    ]),
  ];

  it.each(REFUSED)("refuses %s with a 400 and no query", async (_, ids, message) => {
    const { polls, pollFindMany, many } = batchSetup();
    const ctx = context(ENGINEER, { ids });
    await polls.batchResults(ctx);
    expect(ctx.status).toBe(400);
    expect(ctx.body).toEqual({ error: message });
    expect(pollFindMany).not.toHaveBeenCalled();
    expect(many).not.toHaveBeenCalled();
  });

  it("takes 50 ids, a repeated parameter, and collapses duplicates", async () => {
    const { polls, pollFindMany } = batchSetup();
    // 49 row ids, one of them repeated, plus a documentId: 50 distinct ids.
    const ids = Array.from({ length: 49 }, (_, i) => String(i + 1));
    const ctx = context(ADMIN, { ids: [ids.join(","), "2", docId(2)] });
    await polls.batchResults(ctx);
    expect(ctx.status).toBe(200);
    expect(pollFindMany).toHaveBeenCalledOnce();
    // Row 2 and its documentId are the same poll: listed once.
    expect((ctx.body as { data: { poll: { id: number } }[] }).data.map((r) => r.poll.id)).toEqual([
      2, 3, 4, 5, 6, 8, 9,
    ]);
  });

  describe.each(USERS.map((user) => [user.role.type + ` #${user.id}`, user] as const))(
    "as %s",
    (_, user) => {
      it.each(ADDRESSES)(
        "answers %s exactly like GET /api/polls/:id/results (absent where that is a 404)",
        async (address) => {
          const { polls, votes } = batchSetup();
          const single = context(user, { id: address });
          await votes.results(single);
          const batch = context(user, { ids: address });
          await polls.batchResults(batch);
          expect(batch.status).toBe(200);
          const data = (batch.body as { data: unknown[] }).data;
          if (single.status === 404) expect(data).toEqual([]);
          else expect(data).toEqual([single.body]);
        },
      );
    },
  );

  it("lists the visible polls in the order asked, counted in one statement for the caller", async () => {
    const { polls, many, pollFindMany } = batchSetup();
    const ctx = context(DESIGNER, {
      ids: [docId(5), String(ENG_ONLY.id), docId(2), docId(7), "999", String(LEGACY.id)].join(","),
    });
    await polls.batchResults(ctx);
    type Listed = { poll: { id: number }; counts: number[]; myVoteIndex: number | null };
    const data = (ctx.body as { data: (Listed & { canVote: boolean })[] }).data;
    // ENG_ONLY is outside the designer's audience, 7 is a draft, 999 is missing.
    expect(data.map((r) => r.poll.id)).toEqual([GUEST_VOTE.id, OPEN.id, LEGACY.id]);
    expect(data[1]).toMatchObject({ counts: [0, 2, 0], myVoteIndex: 1, canVote: true });
    // One poll query, published rows only; one count for the visible polls.
    expect(pollFindMany).toHaveBeenCalledOnce();
    expect(pollFindMany.mock.calls[0]?.[0].where).toMatchObject({ publishedAt: { $notNull: true } });
    expect(many).toHaveBeenCalledOnce();
    expect(many.mock.calls[0]?.slice(1)).toEqual([
      [
        { id: GUEST_VOTE.id, optionCount: 3 },
        { id: OPEN.id, optionCount: 3 },
        { id: LEGACY.id, optionCount: 3 },
      ],
      DESIGNER.id,
    ]);
  });

  it("gives a guest only the polls opened to guests, with canVote from guestsCanVote", async () => {
    const { polls } = batchSetup();
    const ids = POLLS.map((poll) => poll.documentId).join(",");
    const guest = context(GUEST, { ids });
    await polls.batchResults(guest);
    const rows = (guest.body as { data: { poll: { id: number }; canVote: boolean }[] }).data;
    expect(rows.map((r) => [r.poll.id, r.canVote])).toEqual([
      [GUEST_READ.id, false],
      [GUEST_VOTE.id, true],
    ]);
    // A guest of Engineering also sees the Engineering poll opened to guests.
    const guestEng = context(GUEST_ENG, { ids });
    await polls.batchResults(guestEng);
    expect(
      (guestEng.body as { data: { poll: { id: number } }[] }).data.map((r) => r.poll.id),
    ).toEqual([GUEST_READ.id, GUEST_VOTE.id, ENG_GUESTS.id]);
  });

  it("names no voter, only the caller's own vote, also on anonymous polls", async () => {
    const { polls } = batchSetup();
    const ctx = context(ENGINEER, { ids: docId(3) });
    await polls.batchResults(ctx);
    const [row] = (ctx.body as { data: Record<string, unknown>[] }).data;
    expect(row).toMatchObject({ counts: [0, 0, 1], total: 1, myVoteIndex: 2 });
    expect(JSON.stringify(row)).not.toContain(String(ENGINEER.id));
  });

  it("answers an empty list when nothing is visible, without a count", async () => {
    const { polls, many } = batchSetup();
    const ctx = context(GUEST, { ids: [docId(2), docId(3), docId(7)].join(",") });
    await polls.batchResults(ctx);
    expect(ctx.body).toEqual({ data: [] });
    expect(many.mock.calls[0]?.[1]).toEqual([]);
  });
});
