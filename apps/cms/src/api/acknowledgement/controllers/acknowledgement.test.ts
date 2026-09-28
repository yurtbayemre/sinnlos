import { describe, expect, it, vi } from "vitest";

import acknowledgementController from "./acknowledgement";

/**
 * POST /api/acknowledgements (S09). Pinned here:
 *   1. the acknowledging user is always the caller (never the payload),
 *   2. the target type is looked up among the map's own keys (FX27: an
 *      inherited key such as "constructor" reached the query, a 500),
 *   3. every unavailable target answers the byte-identical 400
 *      'Target not available for acknowledgement' (no existence oracle),
 *   4. one acknowledgement per user and target,
 *   5. FX27: an announcement outside the caller's audience answers that same
 *      400 (utils/announcement-audience.ts rules, admin_role/editor bypass).
 *
 * The db stub evaluates the `where` of each query against its tables and
 * resolves the populated targeting relations the way db.query does.
 */

const ANN_DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";
const NO_ACK_DOC = "a1b2c3d4e5f6g7h8i9j0k1l2";
const DRAFT_DOC = "d0d1d2d3d4d5d6d7d8d9e0e1";
interface Caller {
  id: number;
  role: { type: string };
}

const MEMBER: Caller = { id: 5, role: { type: "member" } };
const EDITOR: Caller = { id: 6, role: { type: "editor" } };
const ADMIN: Caller = { id: 7, role: { type: "admin_role" } };

const TARGETED_DOC = "t0t1t2t3t4t5t6t7t8t9u0u1";
const DEPT_SALES = 10;
const DEPT_OPS = 11;
const TEAM_ALPHA = 20;
const ROLE_MEMBER = 30;
const ROLE_GUEST = 31;

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
      // Draft row without targeting: the PUBLISHED row's targeting decides.
      { id: 5, documentId: TARGETED_DOC, requiresAck: true, publishedAt: null },
      {
        id: 6,
        documentId: TARGETED_DOC,
        requiresAck: true,
        publishedAt: "2026-09-01T00:00:00.000Z",
        department: { id: DEPT_SALES },
      },
    ],
    "api::document.document": [],
    "api::acknowledgement.acknowledgement": [],
    "plugin::users-permissions.user": [
      { id: MEMBER.id, role: { id: ROLE_MEMBER }, department: { id: DEPT_SALES }, teams: [] },
      { id: EDITOR.id, role: { id: 40 }, department: { id: DEPT_OPS }, teams: [] },
      { id: ADMIN.id, role: { id: 41 }, department: null, teams: [] },
    ],
    "api::team.team": [{ id: TEAM_ALPHA, lead: { id: 8 } }],
  };
}

/** A published announcement that requires acknowledgement, with the given targeting. */
function withTargeting(targeting: Row): Record<string, Row[]> {
  const tables = baseTables();
  tables["api::announcement.announcement"] = [
    {
      id: 6,
      documentId: TARGETED_DOC,
      requiresAck: true,
      publishedAt: "2026-09-01T00:00:00.000Z",
      ...targeting,
    },
  ];
  return tables;
}

function setup(body: unknown, tables = baseTables()) {
  const calls: { uid: string; op: string; params: Row }[] = [];
  const query = (uid: string) => ({
    findOne: vi.fn(async (params: { where: Where }) => {
      calls.push({ uid, op: "findOne", params });
      return (tables[uid] ?? []).find((row) => matches(row, params.where)) ?? null;
    }),
    findMany: vi.fn(async (params: Row) => {
      calls.push({ uid, op: "findMany", params });
      return tables[uid] ?? [];
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
    state: { user: MEMBER as Caller | undefined },
    request: { body },
    badRequest: vi.fn((message: string) => ({ status: 400, message })),
    unauthorized: vi.fn(() => ({ status: 401 })),
    send: vi.fn((payload: unknown) => payload),
  };
  return { controller, ctx, calls, tables };
}

async function create(body: unknown, tables?: Record<string, Row[]>, user: Caller = MEMBER) {
  const s = setup(body, tables);
  s.ctx.state.user = user;
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

describe("acknowledgement create: audience (FX27)", () => {
  const body = { data: { targetType: "announcement", targetDocumentId: TARGETED_DOC } };
  const created = (calls: { op: string }[]) => calls.some((c) => c.op === "create");

  it("lets a member of the targeted department acknowledge", async () => {
    const { ctx, calls } = await create(body);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(created(calls)).toBe(true);
  });

  it("populates the targeting of the published row", async () => {
    const { calls } = await create(body);
    expect(calls[0]).toMatchObject({
      uid: "api::announcement.announcement",
      params: {
        where: { documentId: TARGETED_DOC, publishedAt: { $notNull: true } },
        populate: {
          department: { select: ["id"] },
          team: { select: ["id"] },
          audienceRoles: { select: ["id"] },
        },
      },
    });
  });

  it("answers an out-of-audience caller with the SAME 400 as a missing target", async () => {
    const outside = { ...MEMBER, id: 9 };
    const tables = baseTables();
    tables["plugin::users-permissions.user"].push({
      id: 9,
      role: { id: ROLE_MEMBER },
      department: { id: DEPT_OPS },
      teams: [],
    });
    const hidden = await create(body, tables, outside);
    const missing = await create(
      { data: { targetType: "announcement", targetDocumentId: "zzzzzzzzzzzzzzzzzzzzzzzz" } },
      undefined,
      outside,
    );
    expect(hidden.ctx.badRequest).toHaveBeenCalledWith(NOT_AVAILABLE);
    expect(hidden.ctx.badRequest.mock.calls).toEqual(missing.ctx.badRequest.mock.calls);
    expect(created(hidden.calls)).toBe(false);
    // Checked before the duplicate lookup: no hint that a row exists.
    expect(hidden.calls.some((c) => c.uid === "api::acknowledgement.acknowledgement")).toBe(false);
  });

  it("applies team (member or lead) and role criteria, AND-combined", async () => {
    const lead = { id: 8, role: { type: "member" } };
    const tables = withTargeting({ team: { id: TEAM_ALPHA } });
    tables["plugin::users-permissions.user"].push({
      id: 8,
      role: { id: ROLE_MEMBER },
      department: null,
      teams: [],
    });
    expect((await create(body, tables, lead)).ctx.badRequest).not.toHaveBeenCalled();
    expect(
      (await create(body, withTargeting({ team: { id: TEAM_ALPHA } }))).ctx.badRequest,
    ).toHaveBeenCalledWith(NOT_AVAILABLE);

    const roles = { audienceRoles: [{ id: ROLE_GUEST }] };
    expect((await create(body, withTargeting(roles))).ctx.badRequest).toHaveBeenCalledWith(
      NOT_AVAILABLE,
    );
    const both = { department: { id: DEPT_SALES }, audienceRoles: [{ id: ROLE_MEMBER }] };
    expect((await create(body, withTargeting(both))).ctx.badRequest).not.toHaveBeenCalled();
  });

  it("lets admin_role and editor acknowledge any announcement, without a scope lookup", async () => {
    for (const user of [EDITOR, ADMIN]) {
      const { ctx, calls } = await create(body, undefined, user);
      expect(ctx.badRequest, user.role.type).not.toHaveBeenCalled();
      expect(calls.some((c) => c.uid === "plugin::users-permissions.user")).toBe(false);
    }
  });

  it("lets anyone acknowledge an untargeted announcement", async () => {
    const guest = { id: 12, role: { type: "guest" } };
    const { ctx } = await create(
      { data: { targetType: "announcement", targetDocumentId: ANN_DOC } },
      undefined,
      guest,
    );
    expect(ctx.badRequest).not.toHaveBeenCalled();
  });
});
