import { beforeEach, describe, expect, it, vi } from "vitest";
import commentController from "./comment";

/**
 * Comment create builds its payload instead of forwarding it (FX04).
 *
 * The comment schema keeps `parent`/`replies` (dropping them would only leave
 * orphan columns with forceMigration=false, §5.27), and both accept raw ids.
 * Forwarding `...rest` let a member point a new comment's `parent` at a HIDDEN
 * comment and read it back through `populate[parent]` — past the #28 read
 * filter. These tests pin:
 *   1. the core create only ever sees body + resolved anchor + caller,
 *   2. the 400 answers for missing / unresolved / invisible targets stay
 *      byte-identical (no existence oracle, §5.17).
 *
 * `super.create` is a spy on the prototype, exactly where @strapi/core 5.49
 * createCoreController puts the base controller; `isTargetVisible` is mocked
 * (its rules are pinned in target-visibility.test.ts), `resolveWriteTarget`
 * runs for real against a db.query stub.
 */

const mocks = vi.hoisted(() => ({
  superCreate: vi.fn(async (_ctx: unknown) => ({ data: { id: 1 } })),
  isTargetVisible: vi.fn(
    async (_strapi: unknown, _type: string, _documentId: string, _user: unknown) => true,
  ),
}));

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        Object.setPrototypeOf(cfg({ strapi }), { create: mocks.superCreate }),
  },
}));

vi.mock("../../../utils/target-visibility", () => ({
  isTargetVisible: mocks.isTargetVisible,
}));

const KNOWN_DOC = "ann-doc-1";
const MEMBER = { id: 5, role: { type: "member" } };

interface FakeCtx {
  request: { body: unknown };
  state: { user?: typeof MEMBER };
  badRequest: ReturnType<typeof vi.fn>;
}

type CommentController = { create(ctx: FakeCtx): Promise<unknown> };

/** Only the announcement `KNOWN_DOC` exists (published). */
function stubStrapi() {
  const findOne = vi.fn(async ({ where }: { where: { documentId?: string } }) =>
    where.documentId === KNOWN_DOC ? { id: 42, documentId: KNOWN_DOC } : null,
  );
  return { db: { query: vi.fn(() => ({ findOne })) } };
}

function setup(body: unknown) {
  const strapi = stubStrapi();
  const controller = (
    commentController as unknown as (deps: { strapi: unknown }) => CommentController
  )({ strapi });
  const ctx: FakeCtx = {
    request: { body },
    state: { user: MEMBER },
    badRequest: vi.fn((message: string) => ({ status: 400, message })),
  };
  return { strapi, controller, ctx };
}

beforeEach(() => {
  mocks.superCreate.mockClear();
  mocks.isTargetVisible.mockClear();
  mocks.isTargetVisible.mockResolvedValue(true);
});

describe("comment create payload (FX04)", () => {
  const expected = {
    data: { body: "hi", targetType: "announcement", targetDocumentId: KNOWN_DOC, author: MEMBER.id },
  };

  it.each([
    ["raw ids", { parent: 7, replies: [8, 9] }],
    ["connect/set syntax", { parent: { connect: [{ id: 7 }] }, replies: { set: [{ id: 8 }] } }],
    ["documentId syntax", { parent: { documentId: "hidden-comment" } }],
  ])("drops parent/replies given as %s", async (_label, relations) => {
    const { controller, ctx } = setup({
      data: { body: "hi", targetType: "announcement", targetDocumentId: KNOWN_DOC, ...relations },
    });
    await controller.create(ctx);
    expect(ctx.request.body).toEqual(expected);
    expect(mocks.superCreate).toHaveBeenCalledOnce();
  });

  it("drops every other client key and pins author to the caller", async () => {
    const { controller, ctx } = setup({
      data: {
        body: "hi",
        targetType: "announcement",
        targetDocumentId: `  ${KNOWN_DOC} `,
        author: 999,
        targetId: 3,
        id: 11,
        documentId: "forged",
        createdBy: 1,
        locale: "de",
      },
    });
    await controller.create(ctx);
    // The stored anchor is the RESOLVED one (trimmed), never the raw input.
    expect(ctx.request.body).toEqual(expected);
  });

  it("accepts a body without the data envelope", async () => {
    const { controller, ctx } = setup({
      body: "hi",
      targetType: "announcement",
      targetDocumentId: KNOWN_DOC,
      parent: 7,
    });
    await controller.create(ctx);
    expect(ctx.request.body).toEqual(expected);
  });

  it("checks visibility for the resolved anchor and the caller", async () => {
    const { strapi, controller, ctx } = setup({
      data: { body: "hi", targetType: "announcement", targetDocumentId: KNOWN_DOC },
    });
    await controller.create(ctx);
    expect(mocks.isTargetVisible).toHaveBeenCalledWith(strapi, "announcement", KNOWN_DOC, MEMBER);
  });
});

describe("comment create rejections stay byte-identical (§5.17)", () => {
  async function reject(data: Record<string, unknown>, visible = true) {
    mocks.isTargetVisible.mockResolvedValue(visible);
    const { controller, ctx } = setup({ data: { body: "hi", parent: 7, ...data } });
    await controller.create(ctx);
    expect(mocks.superCreate).not.toHaveBeenCalled();
    expect(ctx.badRequest).toHaveBeenCalledOnce();
    return ctx.badRequest.mock.calls[0][0] as string;
  }

  it("answers an unknown targetType with 'Invalid targetType'", async () => {
    expect(await reject({ targetType: "event", targetDocumentId: KNOWN_DOC })).toBe(
      "Invalid targetType",
    );
  });

  it("answers missing, legacy-only, unresolved and invisible targets identically", async () => {
    const messages = [
      await reject({ targetType: "announcement" }),
      await reject({ targetType: "announcement", targetId: 42 }),
      await reject({ targetType: "announcement", targetDocumentId: "does-not-exist" }),
      await reject({ targetType: "announcement", targetDocumentId: KNOWN_DOC }, false),
    ];
    expect(messages).toEqual(Array(4).fill("targetDocumentId required"));
  });
});
