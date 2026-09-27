import { afterEach, describe, expect, it, vi } from "vitest";
import pollVoteController from "./poll-vote";

/**
 * The custom vote/results handlers (decision 02 + FX06 + FX20). They look
 * polls up by the NUMERIC id of the published row through strapi.db.query,
 * which spans draft AND published rows, so:
 *   - a missing id, a malformed id, a draft row and a poll outside the
 *     caller's department audience answer the same 404,
 *   - admin_role/editor read every poll and its results but vote only in
 *     the audience (403 outside it),
 *   - the voter is always the caller, whatever the body says,
 *   - results never carry voter identities, but do carry the caller's own
 *     vote even on anonymous polls.
 *
 * The db stub evaluates the `where` it receives, so dropping the published
 * pin or the voter filter fails the tests.
 */

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
}

interface VoteRow {
  poll: number;
  voter: number;
  optionIndex: number;
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
const POLLS = [DRAFT, OPEN, CLOSING, ENG_ONLY, CLOSED];

/** Row 1 of the Engineering document: the poll links the same documentId. */
const ENGINEER: UserRow = { id: 5, role: { type: "member" }, department: { id: 1, documentId: "d-eng" } };
const DESIGNER: UserRow = { id: 6, role: { type: "member" }, department: { id: 7, documentId: "d-design" } };
const GUEST: UserRow = { id: 7, role: { type: "guest" }, department: null };
const EDITOR_OUTSIDE: UserRow = { id: 8, role: { type: "editor" }, department: null };
const ADMIN_OUTSIDE: UserRow = { id: 9, role: { type: "admin_role" }, department: { id: 7, documentId: "d-design" } };
const USERS = [ENGINEER, DESIGNER, GUEST, EDITOR_OUTSIDE, ADMIN_OUTSIDE];

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

type Handler = (ctx: unknown) => Promise<unknown>;

function setup(options: {
  id: unknown;
  user?: UserRow | null;
  body?: unknown;
  votes?: VoteRow[];
}) {
  const votesTable = [...(options.votes ?? [])];
  const pollFindOne = vi.fn(async ({ where }: { where: Where }) =>
    POLLS.find((row) => matches(row, where)) ?? null,
  );
  const votes = {
    findOne: vi.fn(async ({ where }: { where: Where }) =>
      votesTable.find((row) => matches(row, where)) ?? null,
    ),
    findMany: vi.fn(async ({ where }: { where: Where }) => votesTable.filter((row) => matches(row, where))),
    create: vi.fn(async ({ data }: { data: VoteRow }) => {
      votesTable.push(data);
      return { id: 77, optionIndex: data.optionIndex };
    }),
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
  return { controller, ctx, pollFindOne, votes };
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
      { id: ENG_ONLY.id, user: DESIGNER },
      { id: ENG_ONLY.id, user: GUEST },
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

  it("pins the poll lookup to published rows", async () => {
    const { controller, ctx, pollFindOne } = setup({ id: DRAFT.id });
    await controller.vote(ctx);
    expect(pollFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DRAFT.id, publishedAt: { $notNull: true } } }),
    );
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

  it("records a guest's vote on a company-wide poll", async () => {
    const { controller, ctx, votes } = setup({ id: OPEN.id, user: GUEST });
    await controller.vote(ctx);
    expect(votes.create).toHaveBeenCalledWith({ data: { poll: OPEN.id, optionIndex: 0, voter: GUEST.id } });
  });

  it("lets admin_role/editor vote on a company-wide poll", async () => {
    const { controller, ctx, votes } = setup({ id: OPEN.id, user: EDITOR_OUTSIDE });
    await controller.vote(ctx);
    expect(votes.create).toHaveBeenCalledOnce();
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
    const { controller, ctx, votes } = setup({ id: OPEN.id, user: null });
    await controller.results(ctx);
    expect(ctx.unauthorized).toHaveBeenCalledWith();
    expect(votes.findMany).not.toHaveBeenCalled();
  });

  it("answers the same 404 for a missing, malformed, draft and out-of-audience poll", async () => {
    const cases: { id: unknown; user: UserRow }[] = [
      { id: 999, user: ENGINEER },
      { id: "abc", user: ENGINEER },
      { id: DRAFT.id, user: ENGINEER },
      { id: ENG_ONLY.id, user: DESIGNER },
      { id: ENG_ONLY.id, user: GUEST },
    ];
    for (const { id, user } of cases) {
      const { controller, ctx, votes } = setup({ id, user });
      await controller.results(ctx);
      expect(ctx.notFound, `${String(id)} as ${user.id}`).toHaveBeenCalledWith();
      expect(votes.findMany).not.toHaveBeenCalled();
      expect(ctx.send).not.toHaveBeenCalled();
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
    const { controller, ctx, votes } = setup({
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
        question: OPEN.question,
        options: OPEN.options,
        closesAt: null,
        anonymous: false,
      },
      counts: [1, 2],
      total: 3,
      myVoteIndex: null,
      canVote: true,
      audience: { targeted: false, departments: [] },
    });
    expect(votes.findMany).toHaveBeenCalledWith({ where: { poll: OPEN.id }, select: ["optionIndex"] });
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
    expect(votes.findOne).toHaveBeenCalledWith({
      where: { poll: ENG_ONLY.id, voter: ENGINEER.id },
      select: ["optionIndex"],
    });
    for (const call of votes.findMany.mock.calls) {
      expect(call[0]).not.toHaveProperty("populate");
    }
  });
});
