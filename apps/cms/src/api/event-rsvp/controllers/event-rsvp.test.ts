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
  superFind: vi.fn(async (_ctx: unknown): Promise<{ data: unknown }> => ({ data: [] })),
  superFindOne: vi.fn(async (_ctx: unknown): Promise<{ data: unknown }> => ({ data: null })),
}));

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        Object.setPrototypeOf(cfg({ strapi }), {
          update: mocks.superUpdate,
          find: mocks.superFind,
          findOne: mocks.superFindOne,
        }),
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
  mocks.superFind.mockClear();
  mocks.superFindOne.mockClear();
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

/**
 * S09 (characterisation): the RSVP upsert, the capacity gate and the read
 * privacy filter. The db stub below evaluates the where clauses the
 * controller sends (the `user` relation by id, `$notNull`) and populates
 * `user` the way db.query returns it.
 */

const EVENT_UID = "api::event.event";
const RSVP_UID = "api::event-rsvp.event-rsvp";
const EVENT_DOC = "e0e1e2e3e4e5e6e7e8e9f0f1";
const NOT_AVAILABLE = "Event not available for RSVP";

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function rowMatches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (typeof cond === "object" && cond !== null && "$notNull" in cond) return value != null;
    if (key === "user") return (value as { id?: number } | null)?.id === cond;
    return value === cond;
  });
}

function event(overrides: Row = {}): Row {
  return {
    id: 30,
    documentId: EVENT_DOC,
    rsvpEnabled: true,
    capacity: null,
    publishedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function rsvp(id: number, userId: number, status: string, respondedAt: string | null): Row {
  return { id, user: { id: userId }, targetDocumentId: EVENT_DOC, status, respondedAt };
}

function setupCreate(body: unknown, opts: { events?: Row[]; rsvps?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    [EVENT_UID]: opts.events ?? [event()],
    [RSVP_UID]: opts.rsvps ?? [],
  };
  const log: { uid: string; op: string; params: Row }[] = [];
  const query = (uid: string) => ({
    findOne: vi.fn(async (params: { where: Where }) => {
      log.push({ uid, op: "findOne", params });
      return tables[uid].find((row) => rowMatches(row, params.where)) ?? null;
    }),
    findMany: vi.fn(async (params: { where: Where }) => {
      log.push({ uid, op: "findMany", params });
      return tables[uid].filter((row) => rowMatches(row, params.where)).map((row) => ({ ...row }));
    }),
    delete: vi.fn(async (params: { where: { id: number } }) => {
      log.push({ uid, op: "delete", params });
      tables[uid] = tables[uid].filter((row) => row.id !== params.where.id);
      return null;
    }),
    update: vi.fn(async (params: { where: { id: number }; data: Row }) => {
      log.push({ uid, op: "update", params });
      const row = tables[uid].find((r) => r.id === params.where.id);
      if (row) Object.assign(row, params.data);
      return row;
    }),
    create: vi.fn(async (params: { data: Row }) => {
      log.push({ uid, op: "create", params });
      const row = { id: 500, ...params.data };
      tables[uid].push(row);
      return row;
    }),
  });
  const strapi = { db: { query: vi.fn(query) } };
  const controller = (
    eventRsvpController as unknown as (deps: { strapi: unknown }) => {
      create(ctx: unknown): Promise<unknown>;
    }
  )({ strapi });
  const ctx = {
    state: { user: OWNER as typeof OWNER | undefined },
    request: { body },
    badRequest: vi.fn((message: string) => ({ status: 400, message })),
    unauthorized: vi.fn(() => ({ status: 401 })),
    send: vi.fn((payload: unknown) => payload),
  };
  return { controller, ctx, log, tables };
}

async function answer(body: unknown, opts?: { events?: Row[]; rsvps?: Row[] }) {
  const s = setupCreate(body, opts);
  await s.controller.create(s.ctx);
  return s;
}

const ops = <T extends { uid: string; op: string }>(log: T[], op: string): T[] =>
  log.filter((entry) => entry.uid === RSVP_UID && entry.op === op);

describe("event-rsvp create: upsert and healing (S09)", () => {
  it("creates the first answer for the caller, whatever the payload says", async () => {
    const { ctx, log } = await answer({
      data: { targetDocumentId: EVENT_DOC, status: "maybe", user: 99 },
    });
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(ops(log, "create")[0].params).toEqual({
      data: {
        user: OWNER.id,
        targetDocumentId: EVENT_DOC,
        status: "maybe",
        respondedAt: expect.stringMatching(/Z$/),
      },
    });
  });

  it("updates the existing answer instead of adding a row", async () => {
    const { log, tables } = await answer(
      { data: { targetDocumentId: EVENT_DOC, status: "no" } },
      { rsvps: [rsvp(1, OWNER.id, "yes", "2026-09-10T10:00:00.000Z")] },
    );
    expect(ops(log, "create")).toEqual([]);
    expect(ops(log, "update")[0].params).toMatchObject({
      where: { id: 1 },
      data: { status: "no" },
    });
    expect(tables[RSVP_UID]).toHaveLength(1);
  });

  it("heals duplicates: keeps the newest (respondedAt, then id) and deletes the rest", async () => {
    const { log, tables } = await answer(
      { data: { targetDocumentId: EVENT_DOC, status: "maybe" } },
      {
        rsvps: [
          rsvp(1, OWNER.id, "yes", "2026-09-10T10:00:00.000Z"),
          rsvp(2, OWNER.id, "no", "2026-09-10T11:00:00.000Z"),
          rsvp(3, OWNER.id, "no", "2026-09-10T11:00:00.000Z"),
          rsvp(4, OWNER.id, "yes", null),
          rsvp(5, 8, "yes", "2026-09-10T12:00:00.000Z"),
        ],
      },
    );
    expect(
      ops(log, "delete")
        .map((entry) => (entry.params.where as { id: number }).id)
        .sort(),
    ).toEqual([1, 2, 4]);
    expect(ops(log, "update")[0].params).toMatchObject({ where: { id: 3 } });
    expect(tables[RSVP_UID].map((row) => row.id).sort()).toEqual([3, 5]);
  });
});

describe("event-rsvp create: target and payload checks (S09)", () => {
  it("answers missing, draft-only and RSVP-disabled events with the SAME 400", async () => {
    const cases: Row[][] = [
      [],
      [event({ publishedAt: null })],
      [event({ rsvpEnabled: false })],
      [event({ rsvpEnabled: null })],
    ];
    for (const events of cases) {
      const { ctx, log } = await answer(
        { data: { targetDocumentId: EVENT_DOC, status: "yes" } },
        { events },
      );
      expect(ctx.badRequest.mock.calls).toEqual([[NOT_AVAILABLE]]);
      expect(ops(log, "findMany")).toEqual([]);
    }
  });

  it("looks the event up by documentId, published rows only", async () => {
    const { log } = await answer({ data: { targetDocumentId: EVENT_DOC, status: "yes" } });
    expect(log[0]).toEqual({
      uid: EVENT_UID,
      op: "findOne",
      params: { where: { documentId: EVENT_DOC, publishedAt: { $notNull: true } } },
    });
  });

  it("answers a missing target or an invalid status before any query", async () => {
    for (const [data, message] of [
      [{ status: "yes" }, "targetDocumentId required"],
      [{ targetDocumentId: "", status: "yes" }, "targetDocumentId required"],
      [{ targetDocumentId: EVENT_DOC, status: "YES" }, "Invalid status"],
      [{ targetDocumentId: EVENT_DOC }, "Invalid status"],
      [{ targetDocumentId: EVENT_DOC, status: "constructor" }, "Invalid status"],
    ] as const) {
      const { ctx, log } = await answer({ data });
      expect(ctx.badRequest).toHaveBeenCalledWith(message);
      expect(log).toEqual([]);
    }
  });
});

describe("event-rsvp create: capacity counts distinct yes users (S09)", () => {
  const full = event({ capacity: 2 });

  it("counts a user with duplicate yes rows once", async () => {
    const { ctx } = await answer(
      { data: { targetDocumentId: EVENT_DOC, status: "yes" } },
      {
        events: [full],
        rsvps: [
          rsvp(1, 8, "yes", "2026-09-10T10:00:00.000Z"),
          rsvp(2, 8, "yes", "2026-09-10T11:00:00.000Z"),
        ],
      },
    );
    expect(ctx.badRequest).not.toHaveBeenCalled();
  });

  it("refuses a switch into yes when distinct yes users reach the capacity", async () => {
    const { ctx, log } = await answer(
      { data: { targetDocumentId: EVENT_DOC, status: "yes" } },
      {
        events: [full],
        rsvps: [
          rsvp(1, 8, "yes", "2026-09-10T10:00:00.000Z"),
          rsvp(2, 9, "yes", "2026-09-10T11:00:00.000Z"),
          rsvp(3, OWNER.id, "maybe", "2026-09-10T12:00:00.000Z"),
        ],
      },
    );
    expect(ctx.badRequest).toHaveBeenCalledWith("Event is at capacity");
    expect(ops(log, "update")).toEqual([]);
    expect(ops(log, "create")).toEqual([]);
  });

  it("never counts the caller against themselves, and lets an existing yes stay", async () => {
    const reconfirm = await answer(
      { data: { targetDocumentId: EVENT_DOC, status: "yes" } },
      {
        events: [full],
        rsvps: [
          rsvp(1, 8, "yes", "2026-09-10T10:00:00.000Z"),
          rsvp(2, 9, "yes", "2026-09-10T11:00:00.000Z"),
          rsvp(3, OWNER.id, "yes", "2026-09-10T12:00:00.000Z"),
        ],
      },
    );
    expect(reconfirm.ctx.badRequest).not.toHaveBeenCalled();

    // The caller's stale duplicate yes row does not fill a seat for them.
    const withDuplicate = await answer(
      { data: { targetDocumentId: EVENT_DOC, status: "yes" } },
      {
        events: [full],
        rsvps: [
          rsvp(1, 8, "yes", "2026-09-10T10:00:00.000Z"),
          rsvp(3, OWNER.id, "yes", "2026-09-10T09:00:00.000Z"),
          rsvp(4, OWNER.id, "no", "2026-09-10T12:00:00.000Z"),
        ],
      },
    );
    expect(withDuplicate.ctx.badRequest).not.toHaveBeenCalled();
  });

  it("has no limit without a positive integer capacity", async () => {
    for (const capacity of [null, 0, -1, 1.5, "2"]) {
      const { ctx } = await answer(
        { data: { targetDocumentId: EVENT_DOC, status: "yes" } },
        {
          events: [event({ capacity })],
          rsvps: [
            rsvp(1, 8, "yes", "2026-09-10T10:00:00.000Z"),
            rsvp(2, 9, "yes", "2026-09-10T11:00:00.000Z"),
          ],
        },
      );
      expect(ctx.badRequest, String(capacity)).not.toHaveBeenCalled();
    }
  });
});

describe("event-rsvp find/findOne: stripPrivateUsers (S09)", () => {
  function readRows(): Row[] {
    return [
      rsvp(1, 8, "yes", null),
      rsvp(2, 9, "no", null),
      rsvp(3, 10, "maybe", null),
      rsvp(4, OWNER.id, "no", null),
    ];
  }

  function setupRead(user: { id: number; role: { type: string } } | undefined) {
    const controller = (
      eventRsvpController as unknown as (deps: { strapi: unknown }) => {
        find(ctx: unknown): Promise<{ data: Row[] }>;
        findOne(ctx: unknown): Promise<{ data: Row }>;
      }
    )({ strapi: {} });
    return { controller, ctx: { state: { user } } };
  }

  const users = (rows: Row[]) =>
    rows.map((row) => (row.user as { id: number } | undefined)?.id ?? null);

  it("keeps who said yes and the caller's own answer, drops the other names", async () => {
    mocks.superFind.mockResolvedValueOnce({ data: readRows() });
    const { controller, ctx } = setupRead(OWNER);
    const response = await controller.find(ctx);
    expect(users(response.data)).toEqual([8, null, null, OWNER.id]);
    // Statuses stay countable.
    expect(response.data.map((row) => row.status)).toEqual(["yes", "no", "maybe", "no"]);
  });

  it("strips for editors too; admin_role sees every name", async () => {
    mocks.superFind.mockResolvedValueOnce({ data: readRows() });
    const editor = setupRead({ id: 77, role: { type: "editor" } });
    expect(users((await editor.controller.find(editor.ctx)).data)).toEqual([8, null, null, null]);

    mocks.superFind.mockResolvedValueOnce({ data: readRows() });
    const admin = setupRead({ id: 78, role: { type: "admin_role" } });
    expect(users((await admin.controller.find(admin.ctx)).data)).toEqual([8, 9, 10, OWNER.id]);
  });

  it("strips without a caller", async () => {
    mocks.superFind.mockResolvedValueOnce({ data: readRows() });
    const { controller, ctx } = setupRead(undefined);
    expect(users((await controller.find(ctx)).data)).toEqual([8, null, null, null]);
  });

  it("applies the same rule to findOne", async () => {
    const { controller, ctx } = setupRead(OWNER);
    mocks.superFindOne.mockResolvedValueOnce({ data: rsvp(2, 9, "no", null) });
    expect((await controller.findOne(ctx)).data.user).toBeUndefined();
    mocks.superFindOne.mockResolvedValueOnce({ data: rsvp(4, OWNER.id, "no", null) });
    expect((await controller.findOne(ctx)).data.user).toEqual({ id: OWNER.id });
    mocks.superFindOne.mockResolvedValueOnce({ data: null });
    expect((await controller.findOne(ctx)).data).toBeNull();
  });
});
