import { beforeEach, describe, expect, it, vi } from "vitest";
import { MALFORMED_ENTRY_IDS, failLikePostgres } from "../../../utils/entry-id.test.helper";
import eventRsvpController from "./event-rsvp";

/**
 * The RSVP update route (PUT /api/event-rsvps/:id) takes a numeric id or a
 * documentId; anything else is an unknown RSVP (404) and never reaches the
 * lookup, where Postgres failed on a malformed row id with a 500
 * (EVT-ICS-ID class). The db stub fails like Postgres on such a value;
 * `super.update` is a prototype spy.
 */

const mocks = vi.hoisted(() => ({
  superUpdate: vi.fn(async (_ctx: unknown) => ({ data: { id: 1 } })),
}));

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        Object.setPrototypeOf(cfg({ strapi }), { update: mocks.superUpdate }),
  },
}));

const OWNER = { id: 5, role: { type: "member" } };
const RSVP_DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";
const RSVP = {
  id: 9,
  documentId: RSVP_DOC,
  status: "no",
  targetDocumentId: "a1b2c3d4e5f6g7h8i9j0k1l2",
};

interface Ctx {
  params: { id?: unknown };
  state: { user?: typeof OWNER };
  request: { body: unknown };
  notFound: ReturnType<typeof vi.fn>;
  badRequest: ReturnType<typeof vi.fn>;
  unauthorized: ReturnType<typeof vi.fn>;
}

function setup(id: unknown) {
  const findOne = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    failLikePostgres(where);
    return where.id === RSVP.id || where.documentId === RSVP.documentId ? RSVP : null;
  });
  const strapi = { db: { query: vi.fn(() => ({ findOne })) } };
  const controller = (
    eventRsvpController as unknown as (deps: { strapi: unknown }) => {
      update(ctx: Ctx): Promise<unknown>;
    }
  )({ strapi });
  const ctx: Ctx = {
    params: { id },
    state: { user: OWNER },
    request: { body: { data: { status: "maybe" } } },
    notFound: vi.fn(() => ({ status: 404 })),
    badRequest: vi.fn((message: string) => ({ status: 400, message })),
    unauthorized: vi.fn(() => ({ status: 401 })),
  };
  return { controller, ctx, findOne };
}

beforeEach(() => {
  mocks.superUpdate.mockClear();
});

describe("event-rsvp update: numeric id or documentId, nothing else", () => {
  it("resolves both id shapes and hands the core its documentId", async () => {
    for (const id of ["9", RSVP_DOC]) {
      const { controller, ctx } = setup(id);
      await controller.update(ctx);
      expect(ctx.notFound).not.toHaveBeenCalled();
      expect(ctx.params.id).toBe(RSVP_DOC);
    }
    expect(mocks.superUpdate).toHaveBeenCalledTimes(2);
  });

  it("answers 404 for an unknown RSVP", async () => {
    const { controller, ctx } = setup("10");
    await controller.update(ctx);
    expect(ctx.notFound).toHaveBeenCalled();
  });

  it("answers a malformed or out-of-range id with the same 404, without a lookup", async () => {
    for (const id of MALFORMED_ENTRY_IDS) {
      const { controller, ctx, findOne } = setup(id);
      await controller.update(ctx);
      expect(ctx.notFound, id).toHaveBeenCalled();
      expect(findOne, id).not.toHaveBeenCalled();
    }
    expect(mocks.superUpdate).not.toHaveBeenCalled();
  });
});
