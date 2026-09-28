import { beforeEach, describe, expect, it, vi } from "vitest";

import { MALFORMED_ENTRY_IDS, failLikePostgres } from "../../../utils/entry-id.test.helper";
import teamController from "./team";

/**
 * PUT /api/teams/:id (PL01). global::can-edit-team accepts a documentId or a
 * numeric row id, but the v5 core update resolves only documentIds, so a
 * numeric id passed the policy and then answered 404. The controller
 * translates a numeric row id before the core update; an unknown one is a
 * 404 without the update. Anything else reaches the core update unchanged.
 * `super.update` is a prototype spy.
 */

const mocks = vi.hoisted(() => ({
  superUpdate: vi.fn(async (_ctx: unknown) => ({ data: { id: 5 } })),
}));

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        Object.setPrototypeOf(cfg({ strapi }), { update: mocks.superUpdate }),
  },
}));

const ALPHA_DOC = "a1b2c3d4e5f6g7h8i9j0k1l2";

interface Ctx {
  params: { id?: unknown };
  notFound: ReturnType<typeof vi.fn>;
}

function setup(id: unknown) {
  const findOne = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    failLikePostgres(where);
    return where.id === 5 ? { id: 5, documentId: ALPHA_DOC } : null;
  });
  const strapi = { db: { query: vi.fn(() => ({ findOne })) } };
  const controller = (
    teamController as unknown as (deps: { strapi: unknown }) => {
      update(ctx: Ctx): Promise<unknown>;
    }
  )({ strapi });
  const ctx: Ctx = { params: { id }, notFound: vi.fn(() => ({ status: 404 })) };
  return { controller, ctx, findOne, strapi };
}

beforeEach(() => {
  mocks.superUpdate.mockClear();
});

describe("team update: numeric row id (PL01)", () => {
  it("translates a numeric row id to the documentId before the core update", async () => {
    const { controller, ctx, findOne, strapi } = setup("5");
    await controller.update(ctx);
    expect(strapi.db.query).toHaveBeenCalledWith("api::team.team");
    expect(findOne).toHaveBeenCalledWith({ where: { id: 5 }, select: ["id", "documentId"] });
    expect(ctx.params.id).toBe(ALPHA_DOC);
    expect(mocks.superUpdate).toHaveBeenCalledWith(ctx);
  });

  it("answers 404 for an unknown row id, without the core update", async () => {
    const { controller, ctx } = setup("6");
    await controller.update(ctx);
    expect(ctx.notFound).toHaveBeenCalled();
    expect(mocks.superUpdate).not.toHaveBeenCalled();
  });

  it("hands a documentId and anything else to the core update unchanged, without a lookup", async () => {
    for (const id of [ALPHA_DOC, ...MALFORMED_ENTRY_IDS]) {
      const { controller, ctx, findOne } = setup(id);
      await controller.update(ctx);
      expect(ctx.params.id, id).toBe(id);
      expect(findOne, id).not.toHaveBeenCalled();
    }
    expect(mocks.superUpdate).toHaveBeenCalledTimes(MALFORMED_ENTRY_IDS.length + 1);
  });
});
