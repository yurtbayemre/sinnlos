import { beforeEach, describe, expect, it, vi } from "vitest";
import { MALFORMED_ENTRY_IDS, failLikePostgres } from "../../../utils/entry-id.test.helper";
import classifiedController from "./classified";

/**
 * Ids a request hands the classified controller (EVT-ICS-ID class): on
 * Postgres a lookup on an int4 `id` column with a malformed or out-of-range
 * value fails, and Strapi answered with a 500. Pinned here:
 *   1. update/delete take a numeric id or a documentId; anything else is an
 *      unknown ad (404) and never reaches the lookup,
 *   2. image ids in create/update and in cleanup-uploads must be positive
 *      int4 integers, otherwise the existing 400 answers before any query.
 *
 * The db stub fails like Postgres on a value an int4 `id` lookup cannot
 * take; `super.update`/`super.create`/`super.delete` are prototype spies,
 * where createCoreController puts the core controller.
 */

const mocks = vi.hoisted(() => ({
  superCreate: vi.fn(async (_ctx: unknown) => ({ data: { id: 1 } })),
  superUpdate: vi.fn(async (_ctx: unknown) => ({ data: { id: 1 } })),
  superDelete: vi.fn(async (_ctx: unknown) => ({ data: null })),
  removeUploadFile: vi.fn(async (_strapi: unknown, _file: unknown) => true),
}));

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        Object.setPrototypeOf(cfg({ strapi }), {
          create: mocks.superCreate,
          update: mocks.superUpdate,
          delete: mocks.superDelete,
        }),
  },
}));

vi.mock("../../../utils/upload-orphans", () => ({
  attachedFileIds: async () => new Set<number>(),
  removeUploadFile: mocks.removeUploadFile,
  uploadedByOf: (file: { provider_metadata?: { uploadedBy?: number } }) =>
    file.provider_metadata?.uploadedBy ?? null,
}));

const AUTHOR = { id: 5, role: { type: "member" } };
const AD_DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";
const AD = { id: 7, documentId: AD_DOC, category: "sale", author: { id: AUTHOR.id } };
const IMAGE = { id: 3, mime: "image/png", provider_metadata: { uploadedBy: AUTHOR.id } };

interface Ctx {
  params: { id?: unknown };
  state: { user?: typeof AUTHOR };
  request: { body: unknown };
  body?: unknown;
  notFound: ReturnType<typeof vi.fn>;
  badRequest: ReturnType<typeof vi.fn>;
  unauthorized: ReturnType<typeof vi.fn>;
}

type Handler = (ctx: Ctx) => Promise<unknown>;

function setup(id: unknown, body: unknown = {}) {
  const findOne = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    failLikePostgres(where);
    return where.id === AD.id || where.documentId === AD.documentId ? AD : null;
  });
  const findMany = vi.fn(async ({ where }: { where: { id: { $in: number[] } } }) => {
    for (const fileId of where.id.$in) failLikePostgres({ id: fileId });
    return where.id.$in.includes(IMAGE.id) ? [IMAGE] : [];
  });
  const strapi = { db: { query: vi.fn(() => ({ findOne, findMany })) } };
  const controller = (
    classifiedController as unknown as (deps: { strapi: unknown }) => {
      create: Handler;
      update: Handler;
      delete: Handler;
      cleanupUploads: Handler;
    }
  )({ strapi });
  const ctx: Ctx = {
    params: { id },
    state: { user: AUTHOR },
    request: { body },
    notFound: vi.fn(() => ({ status: 404 })),
    badRequest: vi.fn((message: string) => ({ status: 400, message })),
    unauthorized: vi.fn(() => ({ status: 401 })),
  };
  return { controller, ctx, findOne, findMany };
}

beforeEach(() => {
  mocks.superCreate.mockClear();
  mocks.superUpdate.mockClear();
  mocks.superDelete.mockClear();
  mocks.removeUploadFile.mockClear();
});

describe("classified update/delete: numeric id or documentId, nothing else", () => {
  it("resolves both id shapes and hands the core its documentId", async () => {
    for (const id of ["7", AD_DOC]) {
      const update = setup(id, { data: { title: "Bike" } });
      await update.controller.update(update.ctx);
      expect(update.ctx.params.id).toBe(AD_DOC);

      const remove = setup(id);
      await remove.controller.delete(remove.ctx);
      expect(remove.ctx.params.id).toBe(AD_DOC);
    }
    expect(mocks.superUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.superDelete).toHaveBeenCalledTimes(2);
  });

  it("answers a malformed or out-of-range id with 404, without a lookup", async () => {
    for (const id of MALFORMED_ENTRY_IDS) {
      const update = setup(id, { data: { title: "Bike" } });
      await update.controller.update(update.ctx);
      expect(update.ctx.notFound, id).toHaveBeenCalled();
      expect(update.findOne, id).not.toHaveBeenCalled();

      const remove = setup(id);
      await remove.controller.delete(remove.ctx);
      expect(remove.ctx.notFound, id).toHaveBeenCalled();
      expect(remove.findOne, id).not.toHaveBeenCalled();
    }
    expect(mocks.superUpdate).not.toHaveBeenCalled();
    expect(mocks.superDelete).not.toHaveBeenCalled();
  });
});

describe("classified image ids", () => {
  const OUT_OF_RANGE = [2147483648, 1e20, "2147483648", { id: 99999999999 }];

  it("accepts an own image on create", async () => {
    const { controller, ctx } = setup(undefined, { data: { title: "Bike", images: [IMAGE.id] } });
    await controller.create(ctx);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(mocks.superCreate).toHaveBeenCalledOnce();
  });

  it("refuses an image id beyond int4 on create and update, before the file lookup", async () => {
    for (const image of OUT_OF_RANGE) {
      const create = setup(undefined, { data: { title: "Bike", images: [image] } });
      await create.controller.create(create.ctx);
      expect(create.ctx.badRequest).toHaveBeenCalledWith("Invalid images (max 4 own image files)");
      expect(create.findMany).not.toHaveBeenCalled();

      const update = setup("7", { data: { images: [image] } });
      await update.controller.update(update.ctx);
      expect(update.ctx.badRequest).toHaveBeenCalledWith("Invalid images (max 4 own image files)");
      expect(update.findMany).not.toHaveBeenCalled();
    }
    expect(mocks.superCreate).not.toHaveBeenCalled();
    expect(mocks.superUpdate).not.toHaveBeenCalled();
  });

  it("cleanup-uploads refuses a file id beyond int4 or malformed, before the file lookup", async () => {
    for (const imageId of [...OUT_OF_RANGE.slice(0, 3), "abc", 1.5, 0, -1]) {
      const { controller, ctx, findMany } = setup(undefined, { imageIds: [imageId] });
      await controller.cleanupUploads(ctx);
      expect(ctx.badRequest, String(imageId)).toHaveBeenCalledWith("Invalid file id");
      expect(findMany).not.toHaveBeenCalled();
    }
  });

  it("cleanup-uploads still removes an own, unattached file", async () => {
    const { controller, ctx } = setup(undefined, { imageIds: [IMAGE.id] });
    await controller.cleanupUploads(ctx);
    expect(ctx.body).toEqual({ removed: 1 });
    expect(mocks.removeUploadFile).toHaveBeenCalledOnce();
  });
});

/**
 * S09: the price payload (resolvePrice, private to the controller, pinned
 * through create and update): empty means no price, a finite non-negative
 * number or numeric string is rounded to cents, anything else is a 400
 * before the core write. A giveaway never has a price.
 */
describe("classified price", () => {
  const priceOf = (ctx: Ctx) => (ctx.request.body as { data: { price: unknown } }).data.price;

  it.each<[unknown, number | null]>([
    [undefined, null],
    [null, null],
    ["", null],
    [0, 0],
    ["0", 0],
    [12, 12],
    ["12.5", 12.5],
    [12.345, 12.35],
    ["12.344", 12.34],
    ["1e3", 1000],
    [" 7 ", 7],
  ])("create stores %j as %j", async (price, expected) => {
    const { controller, ctx } = setup(undefined, {
      data: { title: "Bike", category: "sale", price },
    });
    await controller.create(ctx);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(priceOf(ctx)).toBe(expected);
  });

  it("answers an invalid price with 400 on create and update, before the core write", async () => {
    for (const price of [
      "abc",
      -1,
      "-0.01",
      Number.NaN,
      Infinity,
      "Infinity",
      {},
      [1, 2],
      "1,50",
    ]) {
      const create = setup(undefined, { data: { title: "Bike", category: "sale", price } });
      await create.controller.create(create.ctx);
      expect(create.ctx.badRequest, String(price)).toHaveBeenCalledWith("Invalid price");

      const update = setup("7", { data: { price } });
      await update.controller.update(update.ctx);
      expect(update.ctx.badRequest, String(price)).toHaveBeenCalledWith("Invalid price");
    }
    expect(mocks.superCreate).not.toHaveBeenCalled();
    expect(mocks.superUpdate).not.toHaveBeenCalled();
  });

  it("update rounds a new price and leaves the price alone when the payload has none", async () => {
    const withPrice = setup("7", { data: { price: "19.999" } });
    await withPrice.controller.update(withPrice.ctx);
    expect(priceOf(withPrice.ctx)).toBe(20);

    const withoutPrice = setup("7", { data: { title: "Bike" } });
    await withoutPrice.controller.update(withoutPrice.ctx);
    expect("price" in (withoutPrice.ctx.request.body as { data: object }).data).toBe(false);
  });

  it("a giveaway has no price and is not negotiable", async () => {
    const { controller, ctx } = setup(undefined, {
      data: { title: "Sofa", category: "giveaway", price: 50, priceNegotiable: true },
    });
    await controller.create(ctx);
    expect((ctx.request.body as { data: Record<string, unknown> }).data).toMatchObject({
      price: null,
      priceNegotiable: false,
    });
  });
});
