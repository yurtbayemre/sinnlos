import { beforeEach, describe, expect, it, vi } from "vitest";

import kudosController from "./kudos";

/**
 * POST /api/kudos-entries (S09, FX27): `from` is always the caller, `to`
 * must be a user's row id (an integer, what the web's sendKudos sends) and
 * must not be the caller. The core create is a prototype spy.
 */

const mocks = vi.hoisted(() => ({
  superCreate: vi.fn(async (_ctx: unknown) => ({ data: { id: 1 } })),
}));

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        Object.setPrototypeOf(cfg({ strapi }), { create: mocks.superCreate }),
  },
}));

const CALLER = { id: 5, role: { type: "member" } };

interface Ctx {
  state: { user?: typeof CALLER };
  request: { body: unknown };
  badRequest: ReturnType<typeof vi.fn>;
  unauthorized: ReturnType<typeof vi.fn>;
}

function setup(body: unknown) {
  const controller = (
    kudosController as unknown as (deps: { strapi: unknown }) => {
      create(ctx: Ctx): Promise<unknown>;
    }
  )({ strapi: {} });
  const ctx: Ctx = {
    state: { user: CALLER },
    request: { body },
    badRequest: vi.fn((message: string) => ({ status: 400, message })),
    unauthorized: vi.fn(() => ({ status: 401 })),
  };
  return { controller, ctx };
}

beforeEach(() => {
  mocks.superCreate.mockClear();
});

describe("kudos create (FX27)", () => {
  const kudos = { message: "Thanks!", value: "teamwork" };

  it("creates kudos to another user, from the caller", async () => {
    const { controller, ctx } = setup({ data: { ...kudos, to: 9, from: 77 } });
    await controller.create(ctx);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(ctx.request.body).toEqual({ data: { ...kudos, to: 9, from: CALLER.id } });
    expect(mocks.superCreate).toHaveBeenCalledTimes(1);
  });

  it("also takes the payload without the data wrapper", async () => {
    const { controller, ctx } = setup({ ...kudos, to: 9 });
    await controller.create(ctx);
    expect(ctx.request.body).toEqual({ data: { ...kudos, to: 9, from: CALLER.id } });
  });

  it("answers 400 for a missing or non-integer `to`, before the core create", async () => {
    for (const to of [
      undefined,
      null,
      "",
      "9",
      9.5,
      0,
      -1,
      2147483648,
      Number.NaN,
      { id: 9 },
      { connect: [9] },
      [9],
      "k3v9q2m8x7c4b1n6p5z0r2t8",
    ]) {
      const { controller, ctx } = setup({ data: { ...kudos, to } });
      await controller.create(ctx);
      expect(ctx.badRequest, JSON.stringify(to)).toHaveBeenCalledWith("to must be a user id");
    }
    for (const body of [undefined, null, {}, { data: null }, "text"]) {
      const { controller, ctx } = setup(body);
      await controller.create(ctx);
      expect(ctx.badRequest, JSON.stringify(body)).toHaveBeenCalledWith("to must be a user id");
    }
    expect(mocks.superCreate).not.toHaveBeenCalled();
  });

  it("answers 400 for kudos to oneself", async () => {
    const { controller, ctx } = setup({ data: { ...kudos, to: CALLER.id } });
    await controller.create(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith("Kudos cannot be sent to yourself");
    expect(mocks.superCreate).not.toHaveBeenCalled();
  });

  it("answers 401 without a user", async () => {
    const { controller, ctx } = setup({ data: { ...kudos, to: 9 } });
    ctx.state.user = undefined;
    await controller.create(ctx);
    expect(ctx.unauthorized).toHaveBeenCalled();
    expect(mocks.superCreate).not.toHaveBeenCalled();
  });
});
