import { beforeEach, describe, expect, it, vi } from "vitest";

import { MALFORMED_ENTRY_IDS, failLikePostgres } from "../../../utils/entry-id.test.helper";
import departmentController from "./department";

/**
 * PUT /api/departments/:id (PL01). global::can-edit-department accepts a
 * documentId or a numeric row id, but the v5 core update resolves only
 * documentIds, so a numeric id passed the policy and then answered 404. The
 * controller translates a numeric row id before the core update; an unknown
 * one is a 404 without the update. Anything else reaches the core update
 * unchanged. `super.update` is a prototype spy.
 */

const mocks = vi.hoisted(() => ({
  superUpdate: vi.fn(async (_ctx: unknown) => ({ data: { id: 3 } })),
}));

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        Object.setPrototypeOf(cfg({ strapi }), { update: mocks.superUpdate }),
  },
}));

const SALES_DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";

interface Ctx {
  params: { id?: unknown };
  notFound: ReturnType<typeof vi.fn>;
}

function setup(id: unknown) {
  const findOne = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    failLikePostgres(where);
    return where.id === 3 ? { id: 3, documentId: SALES_DOC } : null;
  });
  const strapi = { db: { query: vi.fn(() => ({ findOne })) } };
  const controller = (
    departmentController as unknown as (deps: { strapi: unknown }) => {
      update(ctx: Ctx): Promise<unknown>;
    }
  )({ strapi });
  const ctx: Ctx = { params: { id }, notFound: vi.fn(() => ({ status: 404 })) };
  return { controller, ctx, findOne, strapi };
}

beforeEach(() => {
  mocks.superUpdate.mockClear();
});

describe("department update: numeric row id (PL01)", () => {
  it("translates a numeric row id to the documentId before the core update", async () => {
    const { controller, ctx, findOne, strapi } = setup("3");
    await controller.update(ctx);
    expect(strapi.db.query).toHaveBeenCalledWith("api::department.department");
    expect(findOne).toHaveBeenCalledWith({ where: { id: 3 }, select: ["id", "documentId"] });
    expect(ctx.params.id).toBe(SALES_DOC);
    expect(mocks.superUpdate).toHaveBeenCalledWith(ctx);
  });

  it("answers 404 for an unknown row id, without the core update", async () => {
    const { controller, ctx } = setup("4");
    await controller.update(ctx);
    expect(ctx.notFound).toHaveBeenCalled();
    expect(mocks.superUpdate).not.toHaveBeenCalled();
  });

  it("hands a documentId and anything else to the core update unchanged, without a lookup", async () => {
    for (const id of [SALES_DOC, ...MALFORMED_ENTRY_IDS]) {
      const { controller, ctx, findOne } = setup(id);
      await controller.update(ctx);
      expect(ctx.params.id, id).toBe(id);
      expect(findOne, id).not.toHaveBeenCalled();
    }
    expect(mocks.superUpdate).toHaveBeenCalledTimes(MALFORMED_ENTRY_IDS.length + 1);
  });
});
