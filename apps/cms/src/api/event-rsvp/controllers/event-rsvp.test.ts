import { errors } from "@strapi/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import eventRsvpOwnRows from "../../../policies/event-rsvp-own-rows";
import {
  createStrapiStub,
  matchWhere,
  type Row as StubRow,
} from "../../../test/strapi-stub.test.helper";
import { MALFORMED_ENTRY_IDS, failLikePostgres } from "../../../utils/entry-id.test.helper";
import { MAX_SUMMARY_TARGETS } from "../../../utils/rsvp";
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

/**
 * FX21: GET /api/event-rsvps/summary on the shared stub (S03). The stub
 * evaluates the where clauses, `select` and the user populate like the query
 * engine, and records every call.
 */
describe("event-rsvp summary (FX21)", () => {
  const USER_UID = "plugin::users-permissions.user";
  const EVT_1 = "e1e1e1e1e1e1e1e1e1e1e1e1";
  const EVT_2 = "e2e2e2e2e2e2e2e2e2e2e2e2";
  const DRAFT = "e3e3e3e3e3e3e3e3e3e3e3e3";
  const MISSING = "e4e4e4e4e4e4e4e4e4e4e4e4";

  function setupSummary(rsvps: StubRow[], caller: { id?: number; role?: { type: string } } | null) {
    const strapi = createStrapiStub({
      tables: {
        [USER_UID]: [
          { id: 5, username: "owner", displayName: "Owner" },
          { id: 8, username: "ada", displayName: "Ada" },
          { id: 9, username: "grace", displayName: "Grace" },
          { id: 10, username: "decliner", displayName: "Decliner" },
          { id: 11, username: "unsure", displayName: "Unsure" },
          { id: 12, username: "nameless" },
        ],
        [RSVP_UID]: rsvps,
      },
    });
    const published = { status: "published" as const };
    strapi.seedDocument(
      EVENT_UID,
      { title: "One", rsvpEnabled: true },
      { ...published, documentId: EVT_1 },
    );
    strapi.seedDocument(
      EVENT_UID,
      { title: "Two", rsvpEnabled: true },
      { ...published, documentId: EVT_2 },
    );
    strapi.seedDocument(EVENT_UID, { title: "Draft", rsvpEnabled: true }, { documentId: DRAFT });
    const controller = (
      eventRsvpController as unknown as (deps: { strapi: unknown }) => {
        summary(ctx: unknown): Promise<unknown>;
      }
    )({ strapi });
    const ctx = (targets: unknown) => ({
      state: { user: caller ?? undefined },
      query: { targets },
      badRequest: vi.fn((message: string) => ({ status: 400, message })),
      unauthorized: vi.fn(() => ({ status: 401 })),
      send: vi.fn((payload: unknown) => payload),
    });
    return { strapi, controller, ctx };
  }

  let rowId = 100;
  const at = (hour: number) => `2026-09-10T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const answer = (
    target: string,
    userId: number | null,
    status: string,
    hour: number,
  ): StubRow => ({
    id: rowId++,
    targetDocumentId: target,
    status,
    respondedAt: at(hour),
    user: userId === null ? null : { id: userId },
  });

  it("answers counts, yes names and the caller's own answer per published event", async () => {
    const { controller, ctx } = setupSummary(
      [
        answer(EVT_1, 8, "yes", 9),
        answer(EVT_1, 9, "yes", 8),
        answer(EVT_1, 10, "no", 10),
        answer(EVT_1, 11, "maybe", 11),
        answer(EVT_1, OWNER.id, "maybe", 12),
        answer(EVT_2, 10, "no", 9),
      ],
      OWNER,
    );
    const c = ctx(`${EVT_1},${EVT_2}`);
    const response = await controller.summary(c);
    expect(c.badRequest).not.toHaveBeenCalled();
    expect(response).toEqual({
      data: [
        {
          targetDocumentId: EVT_1,
          yesCount: 2,
          maybeCount: 2,
          noCount: 1,
          // Oldest answer first.
          yesNames: ["Grace", "Ada"],
          myStatus: "maybe",
        },
        {
          targetDocumentId: EVT_2,
          yesCount: 0,
          maybeCount: 0,
          noCount: 1,
          yesNames: [],
          myStatus: null,
        },
      ],
    });
  });

  it("never lets a maybe/no name or a user id leave the CMS, not even for admin_role", async () => {
    const { controller, ctx } = setupSummary(
      [answer(EVT_1, 10, "no", 9), answer(EVT_1, 11, "maybe", 10), answer(EVT_1, 8, "yes", 11)],
      { id: 77, role: { type: "admin_role" } },
    );
    const json = JSON.stringify(await controller.summary(ctx(EVT_1)));
    expect(json).toContain("Ada");
    expect(json).not.toContain("Decliner");
    expect(json).not.toContain("Unsure");
    expect(json).not.toMatch(/"user"|"id"/);
  });

  it("counts a user's duplicate rows once, by the newest answer", async () => {
    const { controller, ctx } = setupSummary(
      [
        answer(EVT_1, 8, "yes", 9),
        answer(EVT_1, 8, "no", 12),
        answer(EVT_1, 8, "maybe", 10),
        answer(EVT_1, OWNER.id, "no", 9),
        answer(EVT_1, OWNER.id, "yes", 11),
      ],
      OWNER,
    );
    const response = (await controller.summary(ctx(EVT_1))) as { data: unknown[] };
    expect(response.data[0]).toMatchObject({
      yesCount: 1,
      maybeCount: 0,
      noCount: 1,
      yesNames: ["Owner"],
      myStatus: "yes",
    });
  });

  it("counts answers whose user is gone, and a yes without a display name, without a name", async () => {
    const { controller, ctx } = setupSummary(
      [answer(EVT_1, null, "yes", 9), answer(EVT_1, null, "yes", 10), answer(EVT_1, 12, "yes", 11)],
      OWNER,
    );
    const response = (await controller.summary(ctx(EVT_1))) as { data: unknown[] };
    expect(response.data[0]).toMatchObject({ yesCount: 3, yesNames: [] });
  });

  it("leaves draft-only and unknown events out, identically, and keeps the requested order", async () => {
    const { controller, ctx } = setupSummary(
      [answer(DRAFT, 8, "yes", 9), answer(MISSING, 8, "yes", 9), answer(EVT_1, 8, "yes", 9)],
      OWNER,
    );
    const response = (await controller.summary(ctx(`${EVT_2},${DRAFT},${MISSING},${EVT_1}`))) as {
      data: { targetDocumentId: string }[];
    };
    expect(response.data.map((s) => s.targetDocumentId)).toEqual([EVT_2, EVT_1]);
    expect(await controller.summary(ctx(`${DRAFT},${MISSING}`))).toEqual({ data: [] });
  });

  it("accepts repeated targets and collapses duplicates", async () => {
    const { controller, ctx } = setupSummary([answer(EVT_1, 8, "yes", 9)], OWNER);
    const response = (await controller.summary(ctx([EVT_1, `${EVT_2},${EVT_1}`]))) as {
      data: { targetDocumentId: string; yesCount: number }[];
    };
    expect(response.data.map((s) => [s.targetDocumentId, s.yesCount])).toEqual([
      [EVT_1, 1],
      [EVT_2, 0],
    ]);
  });

  it("reads published events and the targets' rows only, with the user's id and display name", async () => {
    const { strapi, controller, ctx } = setupSummary([answer(EVT_1, 8, "yes", 9)], OWNER);
    await controller.summary(ctx(EVT_1));
    expect(strapi.calls.map((call) => [call.uid, call.method, call.params])).toEqual([
      [
        EVENT_UID,
        "findMany",
        {
          where: { documentId: { $in: [EVT_1] }, publishedAt: { $notNull: true } },
          select: ["documentId"],
        },
      ],
      [
        RSVP_UID,
        "findMany",
        {
          where: { targetDocumentId: { $in: [EVT_1] } },
          select: ["id", "targetDocumentId", "status", "respondedAt"],
          populate: { user: { select: ["id", "displayName"] } },
        },
      ],
    ]);
  });

  it.each([
    ["no targets", undefined, "targets required"],
    ["an empty list", "", "Invalid targets"],
    ["a malformed id", "abc", "Invalid targets"],
    ["a numeric id", "12", "Invalid targets"],
    ["an empty segment", `${EVT_1},`, "Invalid targets"],
    ["a non-string", { 0: EVT_1 }, "Invalid targets"],
    ["a prototype key", "constructor", "Invalid targets"],
  ])("answers %s with 400 before any query", async (_label, targets, message) => {
    const { strapi, controller, ctx } = setupSummary([], OWNER);
    const c = ctx(targets);
    await controller.summary(c);
    expect(c.badRequest).toHaveBeenCalledWith(message);
    expect(strapi.calls).toEqual([]);
  });

  it(`takes at most ${MAX_SUMMARY_TARGETS} distinct targets`, async () => {
    const ids = Array.from(
      { length: MAX_SUMMARY_TARGETS + 1 },
      (_, i) => `e${String(i).padStart(23, "0")}`,
    );
    const { strapi, controller, ctx } = setupSummary([], OWNER);
    const tooMany = ctx(ids.join(","));
    await controller.summary(tooMany);
    expect(tooMany.badRequest).toHaveBeenCalledWith(`At most ${MAX_SUMMARY_TARGETS} targets`);
    expect(strapi.calls).toEqual([]);

    const enough = ctx([...ids.slice(0, MAX_SUMMARY_TARGETS), ids[0]].join(","));
    await controller.summary(enough);
    expect(enough.badRequest).not.toHaveBeenCalled();
  });

  it("answers 401 without a caller", async () => {
    const { strapi, controller, ctx } = setupSummary([], null);
    const c = ctx(EVT_1);
    await controller.summary(c);
    expect(c.unauthorized).toHaveBeenCalled();
    expect(strapi.calls).toEqual([]);
  });
});

/**
 * FX21: the raw reads as a route runs them — the find/findOne policy
 * (global::event-rsvp-own-rows, the real module) and then the controller.
 * The core find is a spy that answers with the stored rows matching the
 * filters the policy left on the REAL request query (the stub's where
 * evaluator), so "own rows" is observed on the response, not assumed.
 */
describe("event-rsvp raw reads: own rows, no user filter, no v4 shape (FX21)", () => {
  const STORED: Row[] = [
    rsvp(1, 8, "yes", null),
    rsvp(2, 9, "no", null),
    rsvp(3, OWNER.id, "maybe", null),
    rsvp(4, 10, "maybe", null),
  ];
  const ADMIN = { id: 78, role: { type: "admin_role" } };
  const MEMBER = { id: OWNER.id, role: { type: "member" } };
  const EDITOR = { id: 77, role: { type: "editor" } };

  // route() installs a table-backed core find; the other suites expect the
  // hoisted defaults back.
  afterEach(() => {
    mocks.superFind.mockImplementation(async () => ({ data: [] }));
    mocks.superFindOne.mockImplementation(async () => ({ data: null }));
  });

  function route(
    user: { id: number; role: { type: string } },
    query: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    const controller = (
      eventRsvpController as unknown as (deps: { strapi: unknown }) => {
        find(ctx: unknown): Promise<unknown>;
        findOne(ctx: unknown): Promise<unknown>;
      }
    )({ strapi: {} });
    const ctx = {
      state: { user },
      request: { query: JSON.parse(JSON.stringify(query)) as Record<string, unknown> },
      headers,
      badRequest: vi.fn((message: string) => ({ status: 400, message })),
    };
    const answer = (c: typeof ctx) =>
      STORED.filter((row) =>
        matchWhere(RSVP_UID, row as StubRow, c.request.query.filters as Where | undefined),
      ).map((row) => ({ ...row, user: row.user ? { ...(row.user as object) } : row.user }));
    mocks.superFind.mockImplementation(async (c) => ({ data: answer(c as typeof ctx) }));
    mocks.superFindOne.mockImplementation(async (c) => ({
      data: answer(c as typeof ctx)[0] ?? null,
    }));
    const run = async (action: "find" | "findOne") => {
      const allowed = await eventRsvpOwnRows(ctx, undefined, { strapi: {} });
      if (!allowed) return { status: 403 };
      return controller[action](ctx);
    };
    return { ctx, run };
  }

  const ids = (response: unknown) =>
    ((response as { data: Row[] }).data ?? []).map((row) => row.id);

  it("serves a member only their own row", async () => {
    const { ctx, run } = route(MEMBER);
    expect(ids(await run("find"))).toEqual([3]);
    expect(ctx.request.query.filters).toEqual({ user: { id: OWNER.id } });
    // One route() per request: each request parses its own query.
    const one = (await route(MEMBER).run("findOne")) as { data: Row };
    expect(one.data).toMatchObject({ id: 3, user: { id: OWNER.id } });
  });

  it("gives editors no bypass: an RSVP is a personal statement", async () => {
    const { run } = route(EDITOR);
    expect(ids(await run("find"))).toEqual([]);
  });

  it("keeps a client filter, narrowed to the caller's rows", async () => {
    const { ctx, run } = route(MEMBER, { filters: { status: { $eq: "maybe" } } });
    expect(ids(await run("find"))).toEqual([3]);
    expect(ctx.request.query.filters).toEqual({
      $and: [{ status: { $eq: "maybe" } }, { user: { id: OWNER.id } }],
    });
  });

  it("refuses a user.id filter with 400 before the core find runs", async () => {
    const { run } = route(MEMBER, { filters: { user: { id: { $eq: 9 } }, status: "no" } });
    await expect(run("find")).rejects.toBeInstanceOf(errors.ValidationError);
    expect(mocks.superFind).not.toHaveBeenCalled();
  });

  it.each(["v4", "V4", "v5", "anything"])(
    "refuses Strapi-Response-Format: %s with 400 for a non-admin",
    async (format) => {
      for (const action of ["find", "findOne"] as const) {
        const { ctx, run } = route(MEMBER, {}, { "strapi-response-format": format });
        expect(await run(action)).toEqual({
          status: 400,
          message: "Strapi-Response-Format is not supported here",
        });
        expect(ctx.badRequest).toHaveBeenCalledTimes(1);
      }
      expect(mocks.superFind).not.toHaveBeenCalled();
      expect(mocks.superFindOne).not.toHaveBeenCalled();
    },
  );

  it("lets admin_role through: every row and name, user filters and the v4 header", async () => {
    const all = route(ADMIN);
    const response = (await all.run("find")) as { data: Row[] };
    expect(ids(response)).toEqual([1, 2, 3, 4]);
    expect(response.data.map((row) => (row.user as { id: number }).id)).toEqual([
      8,
      9,
      OWNER.id,
      10,
    ]);
    expect(all.ctx.request.query).toEqual({});

    const filtered = route(
      ADMIN,
      { filters: { user: { id: { $eq: 9 } } } },
      {
        "strapi-response-format": "v4",
      },
    );
    expect(ids(await filtered.run("find"))).toEqual([2]);
    expect(filtered.ctx.badRequest).not.toHaveBeenCalled();
  });
});
