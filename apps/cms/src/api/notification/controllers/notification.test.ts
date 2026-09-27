import { beforeEach, describe, expect, it, vi } from "vitest";
import { failLikePostgres } from "../../../utils/entry-id.test.helper";
import notificationController from "./notification";

/**
 * POST /api/notifications/mark-read takes `{ ids }`, a list of notification
 * row ids (numbers, or decimal strings, as before). Each id used to go
 * straight into the int4 `id` lookup, so "abc" or 2147483648 made Postgres
 * fail with a 500 (EVT-ICS-ID class), and a non-array `ids` crashed the
 * handler. Now anything but a non-empty list of row ids is a 400 before any
 * query. Only the caller's own notifications are marked (recipient pin).
 */

const mocks = vi.hoisted(() => ({ emitLiveEvent: vi.fn() }));

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        cfg({ strapi }),
  },
}));

vi.mock("../../../utils/live-events", () => ({ emitLiveEvent: mocks.emitLiveEvent }));

const USER = { id: 5 };

interface Row {
  id: number;
  recipient: number;
  readAt: string | null;
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
  ];
  const findOne = vi.fn(async ({ where }: { where: { id: number; recipient: number } }) => {
    failLikePostgres(where);
    return rows.find((r) => r.id === where.id && r.recipient === where.recipient) ?? null;
  });
  const update = vi.fn(async ({ where }: { where: { id: number } }) => {
    failLikePostgres(where);
    return rows.find((r) => r.id === where.id);
  });
  const strapi = { db: { query: vi.fn(() => ({ findOne, update })) } };
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
  return { controller, ctx, findOne, update };
}

beforeEach(() => {
  mocks.emitLiveEvent.mockClear();
});

describe("notification mark-read", () => {
  it("marks the caller's unread notifications, by number or decimal string", async () => {
    const { controller, ctx, update } = setup({ ids: [1, "2", "3"] });
    await controller.markRead(ctx);
    expect(ctx.send).toHaveBeenCalledWith({ updated: 1 });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].where).toEqual({ id: 1 });
    expect(mocks.emitLiveEvent).toHaveBeenCalledWith({
      kind: "notification",
      recipientId: USER.id,
    });
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
      const { controller, ctx, findOne } = setup(body);
      await controller.markRead(ctx);
      expect(ctx.badRequest, JSON.stringify(body)).toHaveBeenCalledWith("ids required");
      expect(findOne).not.toHaveBeenCalled();
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
      const { controller, ctx, findOne, update } = setup({ ids: [1, bad] });
      await controller.markRead(ctx);
      expect(ctx.badRequest, JSON.stringify(bad)).toHaveBeenCalledWith(
        "ids must be notification ids",
      );
      expect(findOne).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    }
  });
});
