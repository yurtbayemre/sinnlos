import { beforeEach, describe, expect, it, vi } from "vitest";
import { MALFORMED_ENTRY_IDS, failLikePostgres } from "../../../utils/entry-id.test.helper";
import notificationController from "./notification";

/**
 * POST /api/notifications/mark-read takes `{ ids }`, a list of notification
 * row ids (numbers, or decimal strings, as before). Each id used to go
 * straight into the int4 `id` lookup, so "abc" or 2147483648 made Postgres
 * fail with a 500 (EVT-ICS-ID class), and a non-array `ids` crashed the
 * handler. Now anything but a non-empty list of row ids is a 400 before any
 * query.
 *
 * FX27: at most 200 ids per call (400 above), deduplicated, and ONE
 * updateMany whose where binds the caller as recipient and only unread rows,
 * so foreign ids change nothing. The live event is emitted only when a row
 * changed. The db stub evaluates that where clause against its rows, so a
 * dropped recipient or readAt pin fails the test.
 *
 * PL01: DELETE /api/notifications/:id takes a documentId or a numeric row
 * id; a numeric one is translated before the core delete (which resolves
 * documentIds only and answered 204 without deleting), and a malformed id or
 * a missing row answers 404. `super.delete` is a prototype spy.
 */

const mocks = vi.hoisted(() => ({
  emitLiveEvent: vi.fn(),
  superDelete: vi.fn(async (_ctx: unknown) => undefined),
}));

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        Object.setPrototypeOf(cfg({ strapi }), { delete: mocks.superDelete }),
  },
}));

vi.mock("../../../utils/live-events", () => ({ emitLiveEvent: mocks.emitLiveEvent }));

const USER = { id: 5 };

interface Row {
  id: number;
  recipient: number;
  readAt: string | null;
}

interface MarkReadWhere {
  id: { $in: number[] };
  recipient: number;
  readAt: null;
}

interface Ctx {
  state: { user?: typeof USER };
  request: { body: unknown };
  badRequest: ReturnType<typeof vi.fn>;
  unauthorized: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

function setup(body: unknown) {
  const rows: Row[] = [
    { id: 1, recipient: USER.id, readAt: null },
    { id: 2, recipient: USER.id, readAt: "2026-09-01T00:00:00.000Z" },
    { id: 3, recipient: 99, readAt: null },
    { id: 4, recipient: USER.id, readAt: null },
  ];
  const updateMany = vi.fn(
    async ({ where, data }: { where: MarkReadWhere; data: { readAt: string } }) => {
      for (const id of where.id.$in) failLikePostgres({ id });
      const hit = rows.filter(
        (r) =>
          where.id.$in.includes(r.id) &&
          r.recipient === where.recipient &&
          (where.readAt === null ? r.readAt === null : true),
      );
      for (const row of hit) row.readAt = data.readAt;
      return { count: hit.length };
    },
  );
  const findOne = vi.fn();
  const update = vi.fn();
  const strapi = { db: { query: vi.fn(() => ({ findOne, update, updateMany })) } };
  const controller = (
    notificationController as unknown as (deps: { strapi: unknown }) => {
      markRead(ctx: Ctx): Promise<unknown>;
    }
  )({ strapi });
  const ctx: Ctx = {
    state: { user: USER },
    request: { body },
    badRequest: vi.fn((message: string) => ({ status: 400, message })),
    unauthorized: vi.fn(() => ({ status: 401 })),
    send: vi.fn((payload: unknown) => payload),
  };
  return { controller, ctx, rows, updateMany, findOne, update };
}

beforeEach(() => {
  mocks.emitLiveEvent.mockClear();
  mocks.superDelete.mockClear();
});

describe("notification mark-read", () => {
  it("marks the caller's unread notifications in one updateMany, by number or decimal string", async () => {
    const { controller, ctx, rows, updateMany, findOne, update } = setup({ ids: [1, "2", "3"] });
    await controller.markRead(ctx);
    expect(ctx.send).toHaveBeenCalledWith({ updated: 1 });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: { $in: [1, 2, 3] },
      recipient: USER.id,
      readAt: null,
    });
    expect(findOne).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    // Only the caller's unread row changed; the foreign row stays unread.
    expect(rows.find((r) => r.id === 1)?.readAt).not.toBeNull();
    expect(rows.find((r) => r.id === 2)?.readAt).toBe("2026-09-01T00:00:00.000Z");
    expect(rows.find((r) => r.id === 3)?.readAt).toBeNull();
    expect(mocks.emitLiveEvent).toHaveBeenCalledTimes(1);
    expect(mocks.emitLiveEvent).toHaveBeenCalledWith({
      kind: "notification",
      recipientId: USER.id,
    });
  });

  it("changes nothing and emits nothing for foreign or already read ids", async () => {
    const { controller, ctx, rows } = setup({ ids: [3, 2] });
    await controller.markRead(ctx);
    expect(ctx.send).toHaveBeenCalledWith({ updated: 0 });
    expect(rows.find((r) => r.id === 3)?.readAt).toBeNull();
    expect(mocks.emitLiveEvent).not.toHaveBeenCalled();
  });

  it("deduplicates the ids before the query", async () => {
    const { controller, ctx, updateMany } = setup({ ids: [1, "1", 4, 1, "4"] });
    await controller.markRead(ctx);
    expect(updateMany.mock.calls[0][0].where.id).toEqual({ $in: [1, 4] });
    expect(ctx.send).toHaveBeenCalledWith({ updated: 2 });
  });

  it("takes up to 200 ids and answers 400 above that, before any query", async () => {
    const twoHundred = Array.from({ length: 200 }, (_, i) => i + 1);
    const ok = setup({ ids: twoHundred });
    await ok.controller.markRead(ok.ctx);
    expect(ok.ctx.badRequest).not.toHaveBeenCalled();
    expect(ok.updateMany).toHaveBeenCalledTimes(1);

    for (const ids of [[...twoHundred, 201], Array.from({ length: 1000 }, () => 1)]) {
      const { controller, ctx, updateMany } = setup({ ids });
      await controller.markRead(ctx);
      expect(ctx.badRequest).toHaveBeenCalledWith("at most 200 ids per call");
      expect(updateMany).not.toHaveBeenCalled();
    }
  });

  it("answers 400 'ids required' for a missing, empty or non-array list", async () => {
    for (const body of [
      undefined,
      null,
      {},
      { ids: [] },
      { ids: "12" },
      { ids: 12 },
      { ids: { 0: 1 } },
    ]) {
      const { controller, ctx, updateMany } = setup(body);
      await controller.markRead(ctx);
      expect(ctx.badRequest, JSON.stringify(body)).toHaveBeenCalledWith("ids required");
      expect(updateMany).not.toHaveBeenCalled();
    }
  });

  it("answers 400 for any entry that is not a row id, before any query", async () => {
    for (const bad of [
      "abc",
      "1.5",
      1.5,
      0,
      -1,
      "01",
      2147483648,
      "2147483648",
      1e20,
      null,
      {},
      [1],
    ]) {
      const { controller, ctx, updateMany } = setup({ ids: [1, bad] });
      await controller.markRead(ctx);
      expect(ctx.badRequest, JSON.stringify(bad)).toHaveBeenCalledWith(
        "ids must be notification ids",
      );
      expect(updateMany).not.toHaveBeenCalled();
    }
  });

  it("answers 401 without a user", async () => {
    const { controller, ctx, updateMany } = setup({ ids: [1] });
    ctx.state.user = undefined;
    await controller.markRead(ctx);
    expect(ctx.unauthorized).toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});

const NOTIFICATION_DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";

interface DeleteCtx {
  params: { id?: unknown };
  notFound: ReturnType<typeof vi.fn>;
}

function setupDelete(id: unknown) {
  const rows = [{ id: 7, documentId: NOTIFICATION_DOC }];
  const findOne = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    failLikePostgres(where);
    return (
      rows.find(
        (r) =>
          r.id === where.id ||
          (where.documentId !== undefined && r.documentId === where.documentId),
      ) ?? null
    );
  });
  const strapi = { db: { query: vi.fn(() => ({ findOne })) } };
  const controller = (
    notificationController as unknown as (deps: { strapi: unknown }) => {
      delete(ctx: DeleteCtx): Promise<unknown>;
    }
  )({ strapi });
  const ctx: DeleteCtx = { params: { id }, notFound: vi.fn(() => ({ status: 404 })) };
  return { controller, ctx, findOne };
}

describe("notification delete: numeric id or documentId (PL01)", () => {
  it("translates a numeric row id to the documentId before the core delete", async () => {
    const { controller, ctx, findOne } = setupDelete("7");
    await controller.delete(ctx);
    expect(findOne).toHaveBeenCalledWith({ where: { id: 7 }, select: ["id", "documentId"] });
    expect(ctx.params.id).toBe(NOTIFICATION_DOC);
    expect(mocks.superDelete).toHaveBeenCalledWith(ctx);
  });

  it("passes a known documentId on", async () => {
    const { controller, ctx } = setupDelete(NOTIFICATION_DOC);
    await controller.delete(ctx);
    expect(ctx.params.id).toBe(NOTIFICATION_DOC);
    expect(mocks.superDelete).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for an unknown row id or documentId, without the core delete", async () => {
    for (const id of ["8", "zzzzzzzzzzzzzzzzzzzzzzzz"]) {
      const { controller, ctx } = setupDelete(id);
      await controller.delete(ctx);
      expect(ctx.notFound, id).toHaveBeenCalled();
    }
    expect(mocks.superDelete).not.toHaveBeenCalled();
  });

  it("answers a malformed or out-of-range id with 404, without a lookup", async () => {
    for (const id of [...MALFORMED_ENTRY_IDS, undefined, ""]) {
      const { controller, ctx, findOne } = setupDelete(id);
      await controller.delete(ctx);
      expect(ctx.notFound, String(id)).toHaveBeenCalled();
      expect(findOne, String(id)).not.toHaveBeenCalled();
    }
    expect(mocks.superDelete).not.toHaveBeenCalled();
  });
});
