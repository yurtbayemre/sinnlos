import { describe, expect, it, vi } from "vitest";

import acknowledgementController from "./acknowledgement";

/**
 * POST /api/acknowledgements (S09). Pinned here:
 *   1. the acknowledging user is always the caller (never the payload),
 *   2. the target type is looked up among the map's own keys (FX27: an
 *      inherited key such as "constructor" reached the query, a 500),
 *   3. every unavailable target answers the byte-identical 400
 *      'Target not available for acknowledgement' (no existence oracle),
 *   4. one acknowledgement per user and target.
 *
 * The db stub evaluates the `where` of each query against its tables.
 */

const ANN_DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";
const NO_ACK_DOC = "a1b2c3d4e5f6g7h8i9j0k1l2";
const DRAFT_DOC = "d0d1d2d3d4d5d6d7d8d9e0e1";
const MEMBER = { id: 5, role: { type: "member" } };

const NOT_AVAILABLE = "Target not available for acknowledgement";

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        cfg({ strapi }),
  },
}));

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (typeof cond === "object" && cond !== null && "$notNull" in cond) {
      return value != null;
    }
    return value === cond;
  });
}

function baseTables(): Record<string, Row[]> {
  return {
    "api::announcement.announcement": [
      { id: 1, documentId: ANN_DOC, requiresAck: true, publishedAt: null },
      { id: 2, documentId: ANN_DOC, requiresAck: true, publishedAt: "2026-09-01T00:00:00.000Z" },
      {
        id: 3,
        documentId: NO_ACK_DOC,
        requiresAck: false,
        publishedAt: "2026-09-01T00:00:00.000Z",
      },
      { id: 4, documentId: DRAFT_DOC, requiresAck: true, publishedAt: null },
    ],
    "api::document.document": [],
    "api::acknowledgement.acknowledgement": [],
  };
}

function setup(body: unknown, tables = baseTables()) {
  const calls: { uid: string; op: string; params: Row }[] = [];
  const query = (uid: string) => ({
    findOne: vi.fn(async (params: { where: Where }) => {
      calls.push({ uid, op: "findOne", params });
      return (tables[uid] ?? []).find((row) => matches(row, params.where)) ?? null;
    }),
    create: vi.fn(async (params: { data: Row }) => {
      calls.push({ uid, op: "create", params });
      const row = { id: 100, ...params.data };
      (tables[uid] ??= []).push(row);
      return row;
    }),
  });
  const strapi = { db: { query: vi.fn(query) } };
  const controller = (
    acknowledgementController as unknown as (deps: { strapi: unknown }) => {
      create(ctx: unknown): Promise<unknown>;
    }
  )({ strapi });
  const ctx = {
    state: { user: MEMBER as typeof MEMBER | undefined },
    request: { body },
    badRequest: vi.fn((message: string) => ({ status: 400, message })),
    unauthorized: vi.fn(() => ({ status: 401 })),
    send: vi.fn((payload: unknown) => payload),
  };
  return { controller, ctx, calls, tables };
}

async function create(body: unknown, tables?: Record<string, Row[]>) {
  const s = setup(body, tables);
  await s.controller.create(s.ctx);
  return s;
}

describe("acknowledgement create: target type (FX27)", () => {
  it("answers 'Invalid targetType' for unknown and inherited keys, before any query", async () => {
    for (const targetType of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "poll",
      "",
      undefined,
      null,
      7,
      {},
    ]) {
      const { ctx, calls } = await create({ data: { targetType, targetDocumentId: ANN_DOC } });
      expect(ctx.badRequest, String(targetType)).toHaveBeenCalledWith("Invalid targetType");
      expect(calls).toEqual([]);
    }
  });

  it("answers 'targetDocumentId required' for a missing or non-string documentId", async () => {
    for (const targetDocumentId of [undefined, null, "", 5, {}]) {
      const { ctx, calls } = await create({
        data: { targetType: "announcement", targetDocumentId },
      });
      expect(ctx.badRequest).toHaveBeenCalledWith("targetDocumentId required");
      expect(calls).toEqual([]);
    }
  });
});

describe("acknowledgement create: targets and duplicates", () => {
  it("acknowledges a published announcement that requires it, for the caller", async () => {
    const { ctx, calls } = await create({
      data: { targetType: "announcement", targetDocumentId: ANN_DOC, user: 99 },
    });
    expect(ctx.badRequest).not.toHaveBeenCalled();
    const created = calls.find((c) => c.op === "create");
    expect(created?.params.data).toEqual({
      user: MEMBER.id,
      targetType: "announcement",
      targetDocumentId: ANN_DOC,
      acknowledgedAt: expect.any(String),
    });
    expect(ctx.send).toHaveBeenCalledWith({ data: expect.objectContaining({ user: MEMBER.id }) });
  });

  it("also takes the payload without the data wrapper", async () => {
    const { ctx } = await create({ targetType: "announcement", targetDocumentId: ANN_DOC });
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalled();
  });

  it("answers missing, draft-only, requiresAck=false and document targets with the SAME 400", async () => {
    for (const [targetType, targetDocumentId] of [
      ["announcement", "zzzzzzzzzzzzzzzzzzzzzzzz"],
      ["announcement", DRAFT_DOC],
      ["announcement", NO_ACK_DOC],
      ["document", ANN_DOC],
    ]) {
      const { ctx, calls } = await create({ data: { targetType, targetDocumentId } });
      expect(ctx.badRequest, `${targetType} ${targetDocumentId}`).toHaveBeenCalledWith(
        NOT_AVAILABLE,
      );
      expect(calls.some((c) => c.op === "create")).toBe(false);
    }
  });

  it("pins the target lookup to published rows", async () => {
    const { calls } = await create({
      data: { targetType: "announcement", targetDocumentId: ANN_DOC },
    });
    expect(calls[0]).toMatchObject({
      uid: "api::announcement.announcement",
      op: "findOne",
      params: { where: { documentId: ANN_DOC, publishedAt: { $notNull: true } } },
    });
  });

  it("answers 'Already acknowledged' for a second acknowledgement", async () => {
    const tables = baseTables();
    tables["api::acknowledgement.acknowledgement"].push({
      id: 50,
      user: MEMBER.id,
      targetType: "announcement",
      targetDocumentId: ANN_DOC,
    });
    const { ctx, calls } = await create(
      { data: { targetType: "announcement", targetDocumentId: ANN_DOC } },
      tables,
    );
    expect(ctx.badRequest).toHaveBeenCalledWith("Already acknowledged");
    expect(calls.some((c) => c.op === "create")).toBe(false);
  });

  it("answers 401 without a user", async () => {
    const s = setup({ data: { targetType: "announcement", targetDocumentId: ANN_DOC } });
    s.ctx.state.user = undefined;
    await s.controller.create(s.ctx);
    expect(s.ctx.unauthorized).toHaveBeenCalled();
    expect(s.calls).toEqual([]);
  });
});
