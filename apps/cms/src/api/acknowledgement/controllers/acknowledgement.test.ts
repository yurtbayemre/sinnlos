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
 *      400 (utils/announcement-audience.ts rules, admin_role/editor bypass);
 *   6. DA02: so does an expired announcement (utils/announcement-expiry.ts),
 *      before the duplicate lookup, with the same admin_role/editor bypass
 *      as every other read of it.
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

  it("answers missing, draft-only, requiresAck=false and wrong-type targets with the SAME 400", async () => {
    for (const [targetType, targetDocumentId] of [
      ["announcement", "zzzzzzzzzzzzzzzzzzzzzzzz"],
      ["announcement", DRAFT_DOC],
      ["announcement", NO_ACK_DOC],
      // An announcement's documentId under the document type: no such document.
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

  it("reads every scalar of the target (no select): the flag and the marker reach the predicate", async () => {
    const { calls } = await create(body);
    expect(calls[0].params).not.toHaveProperty("select");
  });

  it("answers an announcement that targets nobody (D-PT01, retargetRequired) with the SAME 400", async () => {
    const missing = await create({
      data: { targetType: "announcement", targetDocumentId: "zzzzzzzzzzzzzzzzzzzzzzzz" },
    });
    for (const targeting of [
      // D-PT01: restricted without a department or a team.
      { audience: "departments", department: null, team: null },
      // The team was deleted: the caller's department remains, the marker holds.
      { audience: "departments", department: { id: DEPT_SALES }, retargetRequired: true },
    ]) {
      const hidden = await create(body, withTargeting(targeting));
      expect(hidden.ctx.badRequest.mock.calls).toEqual(missing.ctx.badRequest.mock.calls);
      expect(created(hidden.calls)).toBe(false);
      expect(hidden.calls.some((c) => c.uid === "api::acknowledgement.acknowledgement")).toBe(
        false,
      );
      for (const user of [EDITOR, ADMIN]) {
        const bypass = await create(body, withTargeting(targeting), user);
        expect(bypass.ctx.badRequest, user.role.type).not.toHaveBeenCalled();
      }
    }
    // Re-targeted (marker off): the department criterion admits the member again.
    const retargeted = await create(
      body,
      withTargeting({
        audience: "departments",
        department: { id: DEPT_SALES },
        retargetRequired: false,
      }),
    );
    expect(retargeted.ctx.badRequest).not.toHaveBeenCalled();
  });

  it("re-reads the marker after the relations: a torn read answers the same 400", async () => {
    // Committed: the team was deleted and the marker set; the lookup's
    // scalars were read before, its relations after.
    const tables = withTargeting({
      audience: "departments",
      department: { id: DEPT_SALES },
      retargetRequired: true,
    });
    const { ctx } = setup(body, tables);
    const torn = { ...tables["api::announcement.announcement"][0], retargetRequired: false };
    const strapiQuery = vi.fn((uid: string) => ({
      findOne: vi.fn(async (params: { where: Where }) =>
        uid === "api::announcement.announcement"
          ? torn
          : ((tables[uid] ?? []).find((row) => matches(row, params.where)) ?? null),
      ),
      findMany: vi.fn(async () => tables[uid] ?? []),
      create: vi.fn(async (params: { data: Row }) => ({ id: 100, ...params.data })),
    }));
    const controller = (
      acknowledgementController as unknown as (deps: { strapi: unknown }) => {
        create(ctx: unknown): Promise<unknown>;
      }
    )({ strapi: { db: { query: strapiQuery } } });
    await controller.create(ctx);
    expect(ctx.badRequest).toHaveBeenCalledWith(NOT_AVAILABLE);
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

describe("acknowledgement create: expiry (DA02)", () => {
  const body = { data: { targetType: "announcement", targetDocumentId: TARGETED_DOC } };
  const missing = {
    data: { targetType: "announcement", targetDocumentId: "zzzzzzzzzzzzzzzzzzzzzzzz" },
  };
  const created = (calls: { op: string }[]) => calls.some((c) => c.op === "create");
  const PAST = "2020-01-01T00:00:00.000Z";
  const FUTURE = "2099-01-01T00:00:00.000Z";
  /** The targeted announcement, in the member's department, ending at `expiresAt`. */
  const ending = (expiresAt: string | null) =>
    withTargeting({ department: { id: DEPT_SALES }, expiresAt });

  it("answers an expired announcement with the SAME 400 as a missing target, before the duplicate lookup", async () => {
    const expired = await create(body, ending(PAST));
    const gone = await create(missing);
    expect(expired.ctx.badRequest).toHaveBeenCalledWith(NOT_AVAILABLE);
    expect(expired.ctx.badRequest.mock.calls).toEqual(gone.ctx.badRequest.mock.calls);
    expect(created(expired.calls)).toBe(false);
    expect(expired.calls.some((c) => c.uid === "api::acknowledgement.acknowledgement")).toBe(false);
    // Expiry is decided before the caller's scope is loaded.
    expect(expired.calls.some((c) => c.uid === "plugin::users-permissions.user")).toBe(false);
  });

  it("answers the generic 400, not 'Already acknowledged', once an acknowledged announcement expired", async () => {
    const tables = ending(PAST);
    tables["api::acknowledgement.acknowledgement"].push({
      id: 50,
      user: MEMBER.id,
      targetType: "announcement",
      targetDocumentId: TARGETED_DOC,
    });
    const { ctx } = await create(body, tables);
    expect(ctx.badRequest.mock.calls).toEqual([[NOT_AVAILABLE]]);
  });

  it("acknowledges an announcement that has not expired or never expires", async () => {
    for (const expiresAt of [FUTURE, null]) {
      const { ctx, calls } = await create(body, ending(expiresAt));
      expect(ctx.badRequest, String(expiresAt)).not.toHaveBeenCalled();
      expect(created(calls), String(expiresAt)).toBe(true);
    }
  });

  it("lets admin_role and editor acknowledge an expired announcement, as they still read it", async () => {
    for (const user of [EDITOR, ADMIN]) {
      const { ctx, calls } = await create(body, ending(PAST), user);
      expect(ctx.badRequest, user.role.type).not.toHaveBeenCalled();
      expect(created(calls), user.role.type).toBe(true);
    }
  });

  it("refuses an expired announcement outside the audience the same way", async () => {
    const tables = withTargeting({ department: { id: DEPT_OPS }, expiresAt: PAST });
    const { ctx } = await create(body, tables);
    expect(ctx.badRequest.mock.calls).toEqual([[NOT_AVAILABLE]]);
  });
});

describe("acknowledgement create: documents (v0.20)", () => {
  const DOC = "f0f1f2f3f4f5f6f7f8f9g0g1";
  const body = { data: { targetType: "document", targetDocumentId: DOC } };
  const missing = {
    data: { targetType: "document", targetDocumentId: "zzzzzzzzzzzzzzzzzzzzzzzz" },
  };
  const created = (calls: { op: string }[]) => calls.some((c) => c.op === "create");
  /** One published document (with its draft twin) carrying the given fields. */
  const withDocument = (fields: Row) => {
    const tables = baseTables();
    tables["api::document.document"] = [
      { id: 60, documentId: DOC, requiresAck: true, publishedAt: null, departments: [] },
      {
        id: 61,
        documentId: DOC,
        requiresAck: true,
        publishedAt: "2026-09-01T00:00:00.000Z",
        audience: "all",
        departments: [],
        ...fields,
      },
    ];
    return tables;
  };

  it("acknowledges a published company-wide document that requires it, for the caller", async () => {
    const { ctx, calls } = await create(body, withDocument({}));
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(calls[0]).toMatchObject({
      uid: "api::document.document",
      params: {
        where: { documentId: DOC, publishedAt: { $notNull: true } },
        populate: { departments: { select: ["id"] } },
      },
    });
    expect(calls.find((c) => c.op === "create")?.params.data).toEqual({
      user: MEMBER.id,
      targetType: "document",
      targetDocumentId: DOC,
      acknowledgedAt: expect.any(String),
    });
  });

  it("lets only members of a linked department acknowledge (flag OR links)", async () => {
    const own = await create(body, withDocument({ departments: [{ id: DEPT_SALES }] }));
    expect(own.ctx.badRequest).not.toHaveBeenCalled();
    // A link restricts whatever the flag says.
    const other = await create(
      body,
      withDocument({ audience: "all", departments: [{ id: DEPT_OPS }] }),
    );
    expect(other.ctx.badRequest.mock.calls).toEqual([[NOT_AVAILABLE]]);
    expect(other.calls.some((c) => c.uid === "api::acknowledgement.acknowledgement")).toBe(false);
  });

  it("answers requiresAck=false, draft-only, outside-audience and flagged-without-departments with the SAME 400", async () => {
    const gone = await create(missing);
    const draftOnly = baseTables();
    draftOnly["api::document.document"] = [
      { id: 60, documentId: DOC, requiresAck: true, publishedAt: null, departments: [] },
    ];
    for (const tables of [
      withDocument({ requiresAck: false }),
      draftOnly,
      withDocument({ departments: [{ id: DEPT_OPS }] }),
      withDocument({ audience: "departments", departments: [] }),
    ]) {
      const { ctx, calls } = await create(body, tables);
      expect(ctx.badRequest.mock.calls).toEqual(gone.ctx.badRequest.mock.calls);
      expect(created(calls)).toBe(false);
    }
  });

  it("lets admin_role and editor acknowledge any document they read, without a scope lookup", async () => {
    for (const fields of [
      { departments: [{ id: 99 }] },
      { audience: "departments", departments: [] },
    ]) {
      for (const user of [EDITOR, ADMIN]) {
        const { ctx, calls } = await create(body, withDocument(fields), user);
        expect(ctx.badRequest, user.role.type).not.toHaveBeenCalled();
        expect(calls.some((c) => c.uid === "plugin::users-permissions.user")).toBe(false);
      }
    }
  });

  it("answers 'Already acknowledged' for a second document acknowledgement", async () => {
    const tables = withDocument({});
    tables["api::acknowledgement.acknowledgement"].push({
      id: 51,
      user: MEMBER.id,
      targetType: "document",
      targetDocumentId: DOC,
    });
    const { ctx } = await create(body, tables);
    expect(ctx.badRequest).toHaveBeenCalledWith("Already acknowledged");
  });
});

describe("acknowledgement reportIndex (v0.31, #173)", () => {
  async function reportIndex(body: unknown, user: Caller | null = ADMIN) {
    const s = setup(body);
    const ctx = {
      ...s.ctx,
      forbidden: vi.fn(() => ({ status: 403 })),
      set: vi.fn(),
    };
    ctx.state.user = user ?? undefined;
    const controller = s.controller as unknown as { reportIndex(ctx: unknown): Promise<unknown> };
    await controller.reportIndex(ctx);
    return { ...s, ctx };
  }

  it("is admin_role's only, whatever the grants say", async () => {
    for (const user of [EDITOR, MEMBER]) {
      const { ctx, calls } = await reportIndex(
        { targetType: "announcement", documentIds: [ANN_DOC] },
        user,
      );
      expect(ctx.forbidden, user.role.type).toHaveBeenCalled();
      expect(calls).toEqual([]);
    }
    expect((await reportIndex({}, null)).ctx.unauthorized).toHaveBeenCalled();
  });

  it("refuses a bad type and more than 20 or malformed documentIds, before any query", async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `doc${i}`);
    for (const body of [
      { targetType: "poll", documentIds: [ANN_DOC] },
      { targetType: "constructor", documentIds: [] },
      { targetType: "announcement" },
      { targetType: "announcement", documentIds: ANN_DOC },
      { targetType: "announcement", documentIds: [""] },
      { targetType: "announcement", documentIds: [5] },
      { targetType: "announcement", documentIds: ["x".repeat(65)] },
      { targetType: "document", documentIds: ids(21) },
    ]) {
      const { ctx, calls } = await reportIndex(body);
      expect(ctx.badRequest, JSON.stringify(body).slice(0, 60)).toHaveBeenCalled();
      expect(calls).toEqual([]);
    }
  });

  it("answers the index and the truncation flag, uncached", async () => {
    const { ctx } = await reportIndex({ targetType: "document", documentIds: ["d1", "d1", "d2"] });
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(ctx.send).toHaveBeenCalledWith({
      data: { acks: { d1: [], d2: [] } },
      meta: { truncated: false },
    });
  });
});
