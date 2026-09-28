import { beforeEach, describe, expect, it, vi } from "vitest";

import pollController from "./poll";

/**
 * POST /api/polls pins the author to the caller (FX20, §5.21): a
 * client-sent author is overwritten, a missing one is filled in. The core
 * create is a prototype spy, where createCoreController puts the base
 * controller.
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
