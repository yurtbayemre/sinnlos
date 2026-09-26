import { afterEach, describe, expect, it, vi } from "vitest";
import pollVoteController from "./poll-vote";

/**
 * The custom vote/results handlers look polls up by NUMERIC row id through
 * strapi.db.query, which spans draft AND published rows. `results` is
 * granted to every role including guest and returned the unpublished
 * question and options of a draft; `vote` accepted ballots on drafts. FX06
 * pins both lookups to published rows: a draft id answers the same 404 as
 * a missing one.
 *
 * The db stub evaluates the `where` it receives, so dropping the pin fails
 * the test. (Audience targeting and the remaining vote validation belong to
 * the poll-targeting work, decisions/02.)
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
  question: string;
  options: string[];
  closesAt: string | null;
  anonymous: boolean;
  publishedAt: string | null;
}

const DRAFT: PollRow = {
  id: 1,
  question: "Unannounced restructuring?",
  options: ["yes", "no"],
  closesAt: null,
  anonymous: true,
  publishedAt: null,
};
const PUBLISHED: PollRow = {
  ...DRAFT,
  id: 2,
  question: "Pizza or sushi?",
  publishedAt: "2026-09-01T00:00:00.000Z",
};
/** Closes on 2026-09-30 ("closes on D" = 23:59:59 Europe/Berlin). */
const CLOSING: PollRow = {
  ...PUBLISHED,
  id: 3,
  question: "Offsite location?",
  closesAt: "2026-09-30T21:59:59.000Z",
};

type Where = Record<string, unknown>;

/** Minimal where evaluator: equality and `$notNull`. */
function matches(row: PollRow, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key as keyof PollRow];
    if (typeof cond === "object" && cond !== null && "$notNull" in cond) {
      return (cond as { $notNull: boolean }).$notNull ? value != null : value == null;
    }
    return String(value) === String(cond);
  });
}

type Handler = (ctx: unknown) => Promise<unknown>;

function setup(id: number, body: unknown = { optionIndex: 0 }) {
  const pollFindOne = vi.fn(
    async ({ where }: { where: Where }) =>
      [DRAFT, PUBLISHED, CLOSING].find((r) => matches(r, where)) ?? null,
  );
  const votes = {
    findOne: vi.fn(async () => null),
    findMany: vi.fn(async () => [{ optionIndex: 1 }]),
    create: vi.fn(async ({ data }: { data: unknown }) => ({ id: 77, ...(data as object) })),
  };
  const strapi = {
    db: {
      query: vi.fn((uid: string) => (uid === "api::poll.poll" ? { findOne: pollFindOne } : votes)),
    },
  };
  const controller = (
    pollVoteController as unknown as (deps: { strapi: unknown }) => {
      vote: Handler;
      results: Handler;
    }
  )({ strapi });
  const ctx = {
    state: { user: { id: 5, role: { type: "member" } } },
    params: { id: String(id) },
    request: { body },
    notFound: vi.fn(),
    badRequest: vi.fn(),
    unauthorized: vi.fn(),
    send: vi.fn(),
  };
  return { controller, ctx, pollFindOne, votes };
}

describe("poll vote (FX06)", () => {
  it("answers a draft poll id exactly like a missing one and records nothing", async () => {
    for (const id of [DRAFT.id, 999]) {
      const { controller, ctx, votes } = setup(id);
      await controller.vote(ctx);
      expect(ctx.notFound).toHaveBeenCalledWith();
      expect(votes.create).not.toHaveBeenCalled();
      expect(ctx.send).not.toHaveBeenCalled();
    }
  });

  it("pins the poll lookup to published rows", async () => {
    const { controller, ctx, pollFindOne } = setup(DRAFT.id);
    await controller.vote(ctx);
    expect(pollFindOne).toHaveBeenCalledWith({
      where: { id: DRAFT.id, publishedAt: { $notNull: true } },
    });
  });

  it("still records a vote on a published poll, voter = caller", async () => {
    const { controller, ctx, votes } = setup(PUBLISHED.id);
    await controller.vote(ctx);
    expect(votes.create).toHaveBeenCalledWith({
      data: { poll: PUBLISHED.id, optionIndex: 0, voter: 5 },
    });
  });
});

describe("poll results (FX06)", () => {
  it("answers a draft poll id exactly like a missing one (no draft question leak)", async () => {
    for (const id of [DRAFT.id, 999]) {
      const { controller, ctx, votes } = setup(id);
      await controller.results(ctx);
      expect(ctx.notFound).toHaveBeenCalledWith();
      expect(votes.findMany).not.toHaveBeenCalled();
      expect(ctx.send).not.toHaveBeenCalled();
    }
  });

  it("pins the poll lookup to published rows", async () => {
    const { controller, ctx, pollFindOne } = setup(DRAFT.id);
    await controller.results(ctx);
    expect(pollFindOne).toHaveBeenCalledWith({
      where: { id: DRAFT.id, publishedAt: { $notNull: true } },
    });
  });

  it("still answers for a published poll", async () => {
    const { controller, ctx } = setup(PUBLISHED.id);
    await controller.results(ctx);
    expect(ctx.send).toHaveBeenCalledWith(
      expect.objectContaining({
        poll: expect.objectContaining({ id: PUBLISHED.id, question: "Pizza or sushi?" }),
        counts: [0, 1],
        total: 1,
      }),
    );
  });
});

describe("poll vote: close rule (datetime contract)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a vote until the instant before closesAt", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-30T21:59:58.999Z") });
    const { controller, ctx, votes } = setup(CLOSING.id);
    await controller.vote(ctx);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(votes.create).toHaveBeenCalledOnce();
  });

  it("is closed at exactly closesAt (now >= closesAt), like the web", async () => {
    vi.useFakeTimers({ now: new Date(CLOSING.closesAt as string) });
    const { controller, ctx, votes } = setup(CLOSING.id);
    await controller.vote(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith("Poll is closed");
    expect(votes.create).not.toHaveBeenCalled();
  });
});
