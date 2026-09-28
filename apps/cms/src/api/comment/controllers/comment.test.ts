import { beforeEach, describe, expect, it, vi } from "vitest";
import { MALFORMED_ENTRY_IDS, failLikePostgres } from "../../../utils/entry-id.test.helper";
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
 *      byte-identical (no existence oracle, §5.17),
 *   3. delete takes a numeric id or a documentId; anything else is an
 *      unknown comment (404) and never reaches the lookup, where Postgres
 *      failed on a malformed row id with a 500 (EVT-ICS-ID class).
 *
 * `super.create`/`super.delete` are spies on the prototype, exactly where
 * @strapi/core 5.49 createCoreController puts the base controller;
 * `isTargetVisible` is mocked (its rules are pinned in
 * target-visibility.test.ts), `resolveWriteTarget` runs for real against a
 * db.query stub.
 */

const mocks = vi.hoisted(() => ({
  superCreate: vi.fn(async (_ctx: unknown) => ({ data: { id: 1 } })),
  superDelete: vi.fn(async (_ctx: unknown) => ({ data: null })),
  isTargetVisible: vi.fn(
    async (_strapi: unknown, _type: string, _documentId: string, _user: unknown) => true,
  ),
}));

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        Object.setPrototypeOf(cfg({ strapi }), {
          create: mocks.superCreate,
          delete: mocks.superDelete,
        }),
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
    data: {
      body: "hi",
      targetType: "announcement",
      targetDocumentId: KNOWN_DOC,
      author: MEMBER.id,
    },
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

describe("comment delete: numeric id or documentId, nothing else", () => {
  const COMMENT_DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";
  const COMMENT = { id: 7, documentId: COMMENT_DOC, author: { id: MEMBER.id } };

  interface DeleteCtx {
    params: { id: unknown };
    state: { user?: { id: number; role: { type: string } } };
    notFound: ReturnType<typeof vi.fn>;
    forbidden: ReturnType<typeof vi.fn>;
  }

  function setupDelete(id: unknown, user: DeleteCtx["state"]["user"] = MEMBER) {
    const findOne = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      failLikePostgres(where);
      return where.id === COMMENT.id || where.documentId === COMMENT.documentId ? COMMENT : null;
    });
    const strapi = { db: { query: vi.fn(() => ({ findOne })) } };
    const controller = (
      commentController as unknown as (deps: { strapi: unknown }) => {
        delete(ctx: DeleteCtx): Promise<unknown>;
      }
    )({ strapi });
    const ctx: DeleteCtx = {
      params: { id },
      state: { user },
      notFound: vi.fn(() => ({ status: 404 })),
      forbidden: vi.fn(() => ({ status: 403 })),
    };
    return { controller, ctx, findOne };
  }

  beforeEach(() => {
    mocks.superDelete.mockClear();
  });

  it("deletes the author's comment by numeric id or documentId, via its documentId", async () => {
    for (const id of ["7", COMMENT_DOC]) {
      mocks.superDelete.mockClear();
      const { controller, ctx } = setupDelete(id);
      await controller.delete(ctx);
      expect(ctx.notFound).not.toHaveBeenCalled();
      expect(mocks.superDelete).toHaveBeenCalledOnce();
      expect(ctx.params.id).toBe(COMMENT_DOC);
    }
  });

  it("answers 404 for an unknown comment", async () => {
    const { controller, ctx } = setupDelete("8");
    await controller.delete(ctx);
    expect(ctx.notFound).toHaveBeenCalled();
    expect(mocks.superDelete).not.toHaveBeenCalled();
  });

  it("answers a malformed or out-of-range id with the same 404, without a lookup", async () => {
    for (const id of MALFORMED_ENTRY_IDS) {
      const { controller, ctx, findOne } = setupDelete(id);
      await controller.delete(ctx);
      expect(ctx.notFound, id).toHaveBeenCalled();
      expect(findOne, id).not.toHaveBeenCalled();
    }
    expect(mocks.superDelete).not.toHaveBeenCalled();
  });

  it("still refuses a stranger", async () => {
    const { controller, ctx } = setupDelete("7", { id: 99, role: { type: "member" } });
    await controller.delete(ctx);
    expect(ctx.forbidden).toHaveBeenCalled();
    expect(mocks.superDelete).not.toHaveBeenCalled();
  });

  it("lets no caller without a numeric id own a comment whose author is gone", async () => {
    const idless = { role: { type: "member" } } as unknown as DeleteCtx["state"]["user"];
    const { controller, ctx, findOne } = setupDelete("7", idless);
    findOne.mockResolvedValueOnce({ id: 7, documentId: COMMENT_DOC, author: null });
    await controller.delete(ctx);
    expect(ctx.forbidden).toHaveBeenCalled();
    expect(mocks.superDelete).not.toHaveBeenCalled();
  });
});
