import { beforeEach, describe, expect, it, vi } from "vitest";

import { MALFORMED_ENTRY_IDS, failLikePostgres } from "../../../utils/entry-id.test.helper";
import reactionController from "./reaction";

/**
 * POST /api/reactions (S09, FX28). Pinned here:
 *   1. guard order: the emoji and `reacted` checks come first (no query for
 *      a malformed payload), then the target resolution, then visibility,
 *      and only then the lookup of the caller's existing reaction, so an
 *      out-of-audience caller can neither add nor remove one;
 *   2. unresolvable and invisible targets answer the byte-identical 400;
 *   3. the lookup where: target anchor + emoji + the caller as author;
 *   4. without `reacted`: the toggle (existing → delete, else create);
 *   5. with `reacted` (FX28, the desired end state): true + existing is a
 *      no-op answering the reaction, true + none creates, false + existing
 *      deletes, false + none is a no-op; a repeated request never flips;
 *   6. PL01: DELETE /api/reactions/:id translates a numeric row id to the
 *      documentId before the core delete; malformed or unknown ids are 404.
 *
 * resolveWriteTarget runs for real against the db stub; isTargetVisible and
 * emitLiveEvent are mocked (their rules are tested where they live). The core
 * create, sanitizeOutput and transformResponse are prototype spies.
 */

const mocks = vi.hoisted(() => ({
  superCreate: vi.fn(async (_ctx: unknown) => ({ data: { id: 900 } })),
  superDelete: vi.fn(async (_ctx: unknown) => undefined),
  sanitizeOutput: vi.fn(async (entity: unknown, _ctx: unknown) => ({ sanitized: entity })),
  transformResponse: vi.fn((data: unknown) => ({ data, meta: {} })),
  isTargetVisible: vi.fn(
    async (_strapi: unknown, _type: string, _documentId: string, _user: unknown) => true,
  ),
  emitLiveEvent: vi.fn(),
}));

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        Object.setPrototypeOf(cfg({ strapi }), {
          create: mocks.superCreate,
          delete: mocks.superDelete,
          sanitizeOutput: mocks.sanitizeOutput,
          transformResponse: mocks.transformResponse,
        }),
  },
}));

vi.mock("../../../utils/target-visibility", () => ({
  isTargetVisible: mocks.isTargetVisible,
}));

vi.mock("../../../utils/live-events", () => ({ emitLiveEvent: mocks.emitLiveEvent }));

const ANN_DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";
const MEMBER = { id: 5, role: { type: "member" } };
const REACTION_UID = "api::reaction.reaction";

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

interface Call {
  uid: string;
  op: string;
  where: Where;
}

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (typeof cond === "object" && cond !== null && "$notNull" in cond) return row[key] != null;
    return row[key] === cond;
  });
}

function setup(body: unknown, reactions: Row[] = []) {
  const tables: Record<string, Row[]> = {
    "api::announcement.announcement": [
      { id: 1, documentId: ANN_DOC, publishedAt: "2026-09-01T00:00:00.000Z" },
    ],
    "api::wiki-page.wiki-page": [],
    [REACTION_UID]: reactions,
  };
  const calls: Call[] = [];
  const query = (uid: string) => ({
    findOne: vi.fn(async ({ where }: { where: Where }) => {
      calls.push({ uid, op: "findOne", where });
      return (tables[uid] ?? []).find((row) => matches(row, where)) ?? null;
    }),
    delete: vi.fn(async ({ where }: { where: Where }) => {
      calls.push({ uid, op: "delete", where });
      tables[uid] = (tables[uid] ?? []).filter((row) => !matches(row, where));
      return null;
    }),
  });
  const strapi = { db: { query: vi.fn(query) } };
  const controller = (
    reactionController as unknown as (deps: { strapi: unknown }) => {
      create(ctx: unknown): Promise<unknown>;
    }
  )({ strapi });
  const ctx = {
    state: { user: MEMBER as typeof MEMBER | undefined },
    request: { body },
    status: 0,
    badRequest: vi.fn((message: string) => ({ status: 400, message })),
    unauthorized: vi.fn(() => ({ status: 401 })),
    send: vi.fn((payload: unknown) => payload),
  };
  return { controller, ctx, calls, tables };
}

async function post(body: unknown, reactions?: Row[]) {
  const s = setup(body, reactions);
  const result = await s.controller.create(s.ctx);
  return { ...s, result };
}

const target = { targetType: "announcement", targetDocumentId: ANN_DOC };
const mine = (emoji = "heart"): Row => ({
  id: 70,
  documentId: "r0r1r2r3r4r5r6r7r8r9s0s1",
  emoji,
  targetType: "announcement",
  targetDocumentId: ANN_DOC,
  author: MEMBER.id,
});

const writes = (calls: Call[]) => calls.filter((c) => c.uid === REACTION_UID && c.op === "delete");
const lookups = (calls: Call[]) =>
  calls.filter((c) => c.uid === REACTION_UID && c.op === "findOne");

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear();
  mocks.isTargetVisible.mockResolvedValue(true);
});

describe("reaction create: guard order", () => {
  it("answers a missing or empty emoji before any query", async () => {
    for (const emoji of [undefined, null, "", 5, {}]) {
      const { ctx, calls } = await post({ data: { ...target, emoji } });
      expect(ctx.badRequest).toHaveBeenCalledWith("emoji required");
      expect(calls).toEqual([]);
      expect(mocks.isTargetVisible).not.toHaveBeenCalled();
    }
  });

  it("answers a non-boolean `reacted` before any query", async () => {
    for (const reacted of [null, "true", 1, 0, {}, []]) {
      const { ctx, calls } = await post({ data: { ...target, emoji: "heart", reacted } });
      expect(ctx.badRequest, JSON.stringify(reacted)).toHaveBeenCalledWith(
        "reacted must be a boolean",
      );
      expect(calls).toEqual([]);
    }
  });

  it("resolves the target before visibility, and visibility before the lookup", async () => {
    const { calls } = await post({ data: { ...target, emoji: "heart" } });
    const lookupIndex = calls.findIndex((c) => c.uid === REACTION_UID);
    const targetIndex = calls.findIndex((c) => c.uid === "api::announcement.announcement");
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    expect(lookupIndex).toBeGreaterThan(targetIndex);
    expect(mocks.isTargetVisible).toHaveBeenCalledWith(
      expect.anything(),
      "announcement",
      ANN_DOC,
      MEMBER,
    );
  });

  it("answers an invalid targetType and a missing anchor without a visibility check", async () => {
    const invalid = await post({ data: { emoji: "heart", targetType: "constructor" } });
    expect(invalid.ctx.badRequest).toHaveBeenCalledWith("Invalid targetType");
    const missing = await post({ data: { emoji: "heart", targetType: "announcement" } });
    expect(missing.ctx.badRequest).toHaveBeenCalledWith("targetDocumentId required");
    expect(mocks.isTargetVisible).not.toHaveBeenCalled();
  });

  it("answers unresolvable and invisible targets with the SAME 400, and never looks up", async () => {
    const unresolved = await post({
      data: {
        emoji: "heart",
        targetType: "announcement",
        targetDocumentId: "zzzzzzzzzzzzzzzzzzzzzzzz",
      },
    });
    mocks.isTargetVisible.mockResolvedValue(false);
    for (const reacted of [undefined, true, false]) {
      const invisible = await post({ data: { ...target, emoji: "heart", reacted } }, [mine()]);
      expect(invisible.ctx.badRequest.mock.calls).toEqual(unresolved.ctx.badRequest.mock.calls);
      // An out-of-audience caller can neither add nor remove a reaction.
      expect(lookups(invisible.calls)).toEqual([]);
      expect(writes(invisible.calls)).toEqual([]);
      expect(invisible.tables[REACTION_UID]).toHaveLength(1);
    }
    expect(mocks.superCreate).not.toHaveBeenCalled();
  });

  it("looks up by target anchor, emoji and the caller as author", async () => {
    const { calls } = await post({ data: { ...target, emoji: "heart", author: 99 } });
    expect(lookups(calls)[0].where).toEqual({
      targetType: "announcement",
      targetDocumentId: ANN_DOC,
      emoji: "heart",
      author: MEMBER.id,
    });
  });
});

describe("reaction create: toggle without `reacted`", () => {
  it("creates a missing reaction with the rebuilt payload", async () => {
    const { ctx } = await post({
      data: { ...target, emoji: "heart", author: 99, targetId: 3, extra: "x" },
    });
    expect(mocks.superCreate).toHaveBeenCalledTimes(1);
    expect(ctx.request.body).toEqual({
      data: { emoji: "heart", ...target, author: MEMBER.id },
    });
  });

  it("removes an existing reaction and pings the target's channel", async () => {
    const { ctx, calls, tables, result } = await post({ data: { ...target, emoji: "heart" } }, [
      mine(),
    ]);
    expect(writes(calls)).toEqual([{ uid: REACTION_UID, op: "delete", where: { id: 70 } }]);
    expect(tables[REACTION_UID]).toEqual([]);
    expect(result).toEqual({ data: null, toggled: "removed" });
    expect(ctx.send).toHaveBeenCalledWith({ data: null, toggled: "removed" });
    expect(mocks.emitLiveEvent).toHaveBeenCalledWith({
      kind: "content",
      targetType: "announcement",
      targetDocumentId: ANN_DOC,
    });
    expect(mocks.superCreate).not.toHaveBeenCalled();
  });

  it("leaves other emojis of the caller alone", async () => {
    const { calls } = await post({ data: { ...target, emoji: "heart" } }, [mine("thumbsup")]);
    expect(writes(calls)).toEqual([]);
    expect(mocks.superCreate).toHaveBeenCalledTimes(1);
  });
});

describe("reaction create: desired end state `reacted` (FX28)", () => {
  it("true + existing: no write, answers the existing reaction with 200", async () => {
    const { ctx, calls, result } = await post(
      { data: { ...target, emoji: "heart", reacted: true } },
      [mine()],
    );
    expect(writes(calls)).toEqual([]);
    expect(mocks.superCreate).not.toHaveBeenCalled();
    expect(mocks.emitLiveEvent).not.toHaveBeenCalled();
    expect(mocks.sanitizeOutput).toHaveBeenCalledWith(mine(), ctx);
    expect(ctx.status).toBe(200);
    expect(result).toEqual({ data: { sanitized: mine() }, meta: {} });
  });

  it("true + none: creates it (without the `reacted` key)", async () => {
    const { ctx } = await post({ data: { ...target, emoji: "heart", reacted: true } });
    expect(mocks.superCreate).toHaveBeenCalledTimes(1);
    expect(ctx.request.body).toEqual({
      data: { emoji: "heart", ...target, author: MEMBER.id },
    });
  });

  it("false + existing: deletes it", async () => {
    const { calls, result } = await post({ data: { ...target, emoji: "heart", reacted: false } }, [
      mine(),
    ]);
    expect(writes(calls)).toHaveLength(1);
    expect(result).toEqual({ data: null, toggled: "removed" });
    expect(mocks.superCreate).not.toHaveBeenCalled();
  });

  it("false + none: no write, 200 with no data", async () => {
    const { calls, result } = await post({ data: { ...target, emoji: "heart", reacted: false } });
    expect(writes(calls)).toEqual([]);
    expect(mocks.superCreate).not.toHaveBeenCalled();
    expect(mocks.emitLiveEvent).not.toHaveBeenCalled();
    expect(result).toEqual({ data: null });
  });

  it("a repeated request keeps the state (double click)", async () => {
    // Two POSTs with reacted=true against the same table: one reaction.
    const reactions: Row[] = [];
    const first = setup({ data: { ...target, emoji: "heart", reacted: true } }, reactions);
    mocks.superCreate.mockImplementationOnce(async () => {
      reactions.push(mine());
      return { data: { id: 70 } };
    });
    await first.controller.create(first.ctx);
    const second = setup({ data: { ...target, emoji: "heart", reacted: true } }, reactions);
    await second.controller.create(second.ctx);
    expect(mocks.superCreate).toHaveBeenCalledTimes(1);
    expect(reactions).toHaveLength(1);
    expect(writes(second.calls)).toEqual([]);
  });

  it("answers 401 without a user", async () => {
    const s = setup({ data: { ...target, emoji: "heart", reacted: true } });
    s.ctx.state.user = undefined;
    await s.controller.create(s.ctx);
    expect(s.ctx.unauthorized).toHaveBeenCalled();
    expect(s.calls).toEqual([]);
  });
});

describe("reaction delete: numeric id or documentId (PL01)", () => {
  const REACTION_DOC = "r0r1r2r3r4r5r6r7r8r9s0s1";

  function setupDelete(id: unknown) {
    const findOne = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      failLikePostgres(where);
      return where.id === 70 || where.documentId === REACTION_DOC
        ? { id: 70, documentId: REACTION_DOC }
        : null;
    });
    const strapi = { db: { query: vi.fn(() => ({ findOne })) } };
    const controller = (
      reactionController as unknown as (deps: { strapi: unknown }) => {
        delete(ctx: unknown): Promise<unknown>;
      }
    )({ strapi });
    const ctx = { params: { id }, notFound: vi.fn(() => ({ status: 404 })) };
    return { controller, ctx, findOne, strapi };
  }

  it("translates a numeric row id to the documentId before the core delete", async () => {
    const { controller, ctx, findOne, strapi } = setupDelete("70");
    await controller.delete(ctx);
    expect(strapi.db.query).toHaveBeenCalledWith(REACTION_UID);
    expect(findOne).toHaveBeenCalledWith({ where: { id: 70 }, select: ["id", "documentId"] });
    expect(ctx.params.id).toBe(REACTION_DOC);
    expect(mocks.superDelete).toHaveBeenCalledWith(ctx);
  });

  it("passes a known documentId on", async () => {
    const { controller, ctx } = setupDelete(REACTION_DOC);
    await controller.delete(ctx);
    expect(ctx.params.id).toBe(REACTION_DOC);
    expect(mocks.superDelete).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for unknown, malformed or out-of-range ids, without the core delete", async () => {
    for (const id of ["71", "zzzzzzzzzzzzzzzzzzzzzzzz"]) {
      const { controller, ctx } = setupDelete(id);
      await controller.delete(ctx);
      expect(ctx.notFound, id).toHaveBeenCalled();
    }
    for (const id of [...MALFORMED_ENTRY_IDS, undefined, ""]) {
      const { controller, ctx, findOne } = setupDelete(id);
      await controller.delete(ctx);
      expect(ctx.notFound, String(id)).toHaveBeenCalled();
      expect(findOne, String(id)).not.toHaveBeenCalled();
    }
    expect(mocks.superDelete).not.toHaveBeenCalled();
  });
});
