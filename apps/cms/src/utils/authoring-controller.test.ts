import { errors } from "@strapi/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createStrapiStub, type StrapiStub } from "../test/strapi-stub.test.helper";
import {
  AUTHORING_SPECS,
  authoringActionsFor,
  documentStatus,
  parseListQuery,
  rowNeedsRetarget,
  writeStatus,
  type AuthoringContext,
  type AuthoringControllerHost,
} from "./authoring-controller";
import { ClassLost, RevisionStale, getAuthoringScope, type AuthoringScope } from "./document-lock";
import { AUTHORING_STATE_KEY, type AuthoringGate } from "./write-gate";

/**
 * The authoring controller (decision 06 §B3, §G, §N2; batch 15 lane 15A),
 * with the Document Service replaced by spies that record the authoring
 * scope each call runs in (the lock itself is utils/document-lock.ts's,
 * exercised over HTTP by authoring-http-concurrency.integration.test.ts):
 *   - query keys refused, status normalised per type;
 *   - the Document Service gets the checked payload and the status, never
 *     `fields` (it would narrow what the lifecycles see);
 *   - the scope carries the If-Match token, the gate's observed revision,
 *     its classifier and the route's missing-class answer; 428 without it;
 *   - lock refusals become Strapi's error envelope (412 with
 *     details.current, 403/404 without);
 *   - the DTO is computed from the rows and the committed revision, with
 *     the ETag; a department author's discard without a published row is
 *     400 neverPublished.
 */

const lock = vi.hoisted(() => ({ locked: 0, calls: [] as string[] }));
vi.mock("./document-lock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./document-lock")>()),
  lockDocument: vi.fn(async (_strapi: unknown, uid: string, documentId: string) => {
    lock.calls.push(`${uid} ${documentId}`);
    return lock.locked;
  }),
}));

const A = "api::announcement.announcement";
const POLL = "api::poll.poll";

beforeEach(() => {
  lock.locked = 0;
  lock.calls.length = 0;
});

describe("writeStatus (§B3 step 3)", () => {
  it("explicit types need draft or published", () => {
    expect(writeStatus({ status: "draft" }, "explicit")).toBe("draft");
    expect(writeStatus({ status: "published" }, "explicit")).toBe("published");
    for (const [query, code] of [
      [{}, "required"],
      [{ status: "" }, "required"],
      [{ status: "live" }, "invalid"],
      [{ status: ["draft"] }, "invalid"],
    ] as const) {
      try {
        writeStatus(query as Record<string, unknown>, "explicit");
        throw new Error("no refusal");
      } catch (error) {
        expect(error, JSON.stringify(query)).toBeInstanceOf(errors.ValidationError);
        expect((error as InstanceType<typeof errors.ValidationError>).details).toEqual({
          keys: ["status"],
          codes: { status: code },
        });
      }
    }
  });

  it("polls always publish; every other query key is refused with its key", () => {
    expect(writeStatus({}, "alwaysPublished")).toBe("published");
    expect(writeStatus({ status: "published" }, "alwaysPublished")).toBe("published");
    expect(() => writeStatus({ status: "draft" }, "alwaysPublished")).toThrow(
      errors.ValidationError,
    );
    try {
      writeStatus({ status: "draft", populate: "*", fields: ["title"], filters: {} }, "explicit");
    } catch (error) {
      expect((error as InstanceType<typeof errors.ValidationError>).details).toEqual({
        keys: ["fields", "filters", "populate"],
      });
    }
  });
});

describe("documentStatus and needsRetarget", () => {
  it("is draft without a published row, modified when the draft was saved after it", () => {
    expect(documentStatus({ updatedAt: "2026-10-01T10:00:00Z" }, null)).toBe("draft");
    expect(
      documentStatus({ updatedAt: "2026-10-01T10:00:00Z" }, { updatedAt: "2026-10-01T10:00:00Z" }),
    ).toBe("published");
    expect(
      documentStatus({ updatedAt: "2026-10-01T10:00:01Z" }, { updatedAt: "2026-10-01T10:00:00Z" }),
    ).toBe("modified");
    expect(
      documentStatus(
        { updatedAt: new Date("2026-10-01T10:00:01Z") },
        { updatedAt: "2026-10-01T10:00:00Z" },
      ),
    ).toBe("modified");
  });

  it("follows the K9 helpers per type", () => {
    expect(rowNeedsRetarget(A, { audience: "departments", department: null, team: null })).toBe(
      true,
    );
    expect(
      rowNeedsRetarget(A, { audience: "departments", department: { id: 1 }, team: null }),
    ).toBe(false);
    expect(rowNeedsRetarget(A, { audience: "all", retargetRequired: true })).toBe(true);
    expect(
      rowNeedsRetarget("api::event.event", { notifyAudience: "departments", departments: [] }),
    ).toBe(true);
    expect(rowNeedsRetarget("api::event.event", { notifyAudience: "all", departments: [] })).toBe(
      false,
    );
    expect(rowNeedsRetarget(POLL, { audience: "departments", departments: [] })).toBe(true);
    expect(rowNeedsRetarget(POLL, null)).toBe(false);
  });
});

describe("parseListQuery", () => {
  it("takes status, q, page, and owner for moderators of the owned types only", () => {
    expect(
      parseListQuery({ status: "scheduled", q: " news ", page: "2", owner: "department" }, true),
    ).toEqual({
      status: "scheduled",
      q: "news",
      page: 2,
      owner: "department",
    });
    expect(parseListQuery({}, false)).toEqual({ page: 1 });
    for (const [query, allowOwner, keys] of [
      [{ owner: "department" }, false, ["owner"]],
      [{ status: "archived" }, true, ["status"]],
      [{ page: "0" }, true, ["page"]],
      [{ page: "abc" }, true, ["page"]],
      [{ sort: "title" }, true, ["sort"]],
      [{ populate: "*", filters: {} }, true, ["filters", "populate"]],
    ] as const) {
      try {
        parseListQuery(query as Record<string, unknown>, allowOwner);
        throw new Error("no refusal");
      } catch (error) {
        expect(
          (error as InstanceType<typeof errors.ValidationError>).details?.keys,
          JSON.stringify(query),
        ).toEqual(keys);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The actions, with Document Service spies

interface Recorded {
  action: string;
  params: Record<string, unknown>;
  scope: AuthoringScope | undefined;
}

function harness(options: { onCall?: (call: Recorded, stub: StrapiStub) => unknown } = {}) {
  const stub = createStrapiStub();
  const calls: Recorded[] = [];
  const record =
    (action: string) =>
    async (params: Record<string, unknown>): Promise<unknown> => {
      const call = { action, params, scope: getAuthoringScope() };
      calls.push(call);
      const result = options.onCall?.(call, stub);
      return result instanceof Promise
        ? result
        : (result ?? { documentId: params.documentId ?? "new" });
    };
  const documents = () => ({
    create: record("create"),
    update: record("update"),
    publish: record("publish"),
    unpublish: record("unpublish"),
    discardDraft: record("discardDraft"),
    delete: record("delete"),
  });
  const host = { ...stub, documents } as unknown as AuthoringControllerHost;
  return { stub, host, calls };
}

const gateFor = (overrides: Partial<AuthoringGate>): AuthoringGate => ({
  uid: A,
  intent: "update",
  roleClass: "moderator",
  callerId: 102,
  callerDepartment: null,
  documentId: "doc0000000000000000000a1",
  observedRevision: 3,
  classify: async () => "moderator",
  ...overrides,
});

function context(
  gate: AuthoringGate | null,
  options: { query?: Record<string, unknown>; ifMatch?: string; body?: unknown; id?: string } = {},
): AuthoringContext & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    state: gate ? { [AUTHORING_STATE_KEY]: gate } : {},
    params: { id: options.id ?? gate?.documentId },
    query: options.query ?? {},
    request: { body: options.body ?? { data: { title: "Checked" } } },
    get: (name: string) => (name.toLowerCase() === "if-match" ? (options.ifMatch ?? "") : ""),
    set: (name: string, value: string) => {
      headers[name] = value;
    },
    status: 404,
    body: null,
    headers,
  };
}

/** Seeds the rows the DTO is read from. */
const seedRows = (stub: StrapiStub, documentId: string, published: boolean) => {
  stub.tables[A] = [
    {
      id: 1,
      documentId,
      title: "T",
      publishedAt: null,
      updatedAt: "2026-10-01T10:00:00.000Z",
      publishAt: null,
      scheduleError: null,
    },
    ...(published
      ? [
          {
            id: 2,
            documentId,
            title: "T",
            publishedAt: "2026-10-01T10:00:00.000Z",
            updatedAt: "2026-10-01T10:00:00.000Z",
          },
        ]
      : []),
  ];
};

describe("update", () => {
  it("runs the Document Service update in a scope with the token, the gate's view and 403 for a lost class", async () => {
    const { stub, host, calls } = harness({
      onCall: (call) => {
        if (call.scope) call.scope.committedRevision = 4;
        return { documentId: call.params.documentId };
      },
    });
    seedRows(stub, "doc0000000000000000000a1", true);
    const gate = gateFor({});
    const ctx = context(gate, { query: { status: "draft" }, ifMatch: '"3"' });
    await authoringActionsFor(host, A).update(ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({
      documentId: "doc0000000000000000000a1",
      data: { title: "Checked" },
      status: "draft",
    });
    expect(calls[0].scope).toMatchObject({
      uid: A,
      documentId: "doc0000000000000000000a1",
      expectedRevision: 3,
      observedRevision: 3,
      classify: gate.classify,
      roleClass: "moderator",
      missingClass: 403,
      source: "content-api",
    });
    expect(ctx.status).toBe(200);
    expect(ctx.body).toEqual({
      data: {
        documentId: "doc0000000000000000000a1",
        version: "4",
        status: "published",
        publishedAt: "2026-10-01T10:00:00.000Z",
        publishAt: null,
        scheduleError: null,
      },
    });
    expect(ctx.headers.ETag).toBe('"4"');
  });

  it("answers 428 without If-Match and writes nothing", async () => {
    const { host, calls } = harness();
    const ctx = context(gateFor({}), { query: { status: "draft" } });
    await authoringActionsFor(host, A).update(ctx);
    expect(ctx.status).toBe(428);
    expect(ctx.body).toMatchObject({
      data: null,
      error: { status: 428, name: "PreconditionRequiredError" },
    });
    expect(calls).toEqual([]);
  });

  it("maps the lock's 412 and lost class to Strapi's error envelope", async () => {
    const stale = harness({ onCall: () => Promise.reject(new RevisionStale(9)) });
    const ctx = context(gateFor({}), { query: { status: "draft" }, ifMatch: '"3"' });
    await authoringActionsFor(stale.host, A).update(ctx);
    expect(ctx.status).toBe(412);
    expect(ctx.body).toEqual({
      data: null,
      error: {
        status: 412,
        name: "PreconditionFailedError",
        message: expect.any(String),
        details: { current: 9 },
      },
    });
    const lost = harness({ onCall: () => Promise.reject(new ClassLost(403)) });
    const lostCtx = context(gateFor({}), { query: { status: "draft" }, ifMatch: '"3"' });
    await authoringActionsFor(lost.host, A).update(lostCtx);
    expect(lostCtx.status).toBe(403);
    expect((lostCtx.body as { error: { details: unknown } }).error.details).toEqual({});
  });

  it("refuses a request the gate did not admit (a route wired without can-author)", async () => {
    const { host, calls } = harness();
    await expect(
      authoringActionsFor(host, A).update(
        context(null, { query: { status: "draft" }, ifMatch: '"1"' }),
      ),
    ).rejects.toBeInstanceOf(errors.ForbiddenError);
    await expect(
      authoringActionsFor(host, A).update(
        context(gateFor({ intent: "publish" }), { query: { status: "draft" }, ifMatch: '"1"' }),
      ),
    ).rejects.toBeInstanceOf(errors.ForbiddenError);
    expect(calls).toEqual([]);
  });

  it("refuses query keys before any write", async () => {
    const { host, calls } = harness();
    await expect(
      authoringActionsFor(host, A).update(
        context(gateFor({}), { query: { status: "draft", populate: "*" }, ifMatch: '"3"' }),
      ),
    ).rejects.toBeInstanceOf(errors.ValidationError);
    expect(calls).toEqual([]);
  });
});

describe("create", () => {
  it("creates with the status, no fields and a scope that binds to the new document", async () => {
    const { stub, host, calls } = harness({
      onCall: (call, s) => {
        seedRows(s, "new0000000000000000000a1", false);
        if (call.scope) call.scope.committedRevision = 1;
        return { documentId: "new0000000000000000000a1" };
      },
    });
    void stub;
    const ctx = context(
      gateFor({ intent: "create", documentId: undefined, observedRevision: undefined }),
      {
        query: { status: "draft" },
      },
    );
    await authoringActionsFor(host, A).create(ctx);
    expect(calls[0].params).toEqual({ data: { title: "Checked" }, status: "draft" });
    expect(calls[0].params).not.toHaveProperty("fields");
    expect(calls[0].scope).toEqual({
      uid: A,
      roleClass: "moderator",
      source: "content-api",
      committedRevision: 1,
    });
    expect(ctx.status).toBe(201);
    expect((ctx.body as { data: unknown }).data).toMatchObject({ version: "1", status: "draft" });
  });

  it("polls publish without a status", async () => {
    const { host, calls } = harness({
      onCall: (call, s) => {
        s.tables[POLL] = [
          {
            id: 1,
            documentId: "pol0000000000000000000a1",
            publishedAt: null,
            updatedAt: "2026-10-01T10:00:00Z",
          },
          {
            id: 2,
            documentId: "pol0000000000000000000a1",
            publishedAt: "2026-10-01T10:00:00Z",
            updatedAt: "2026-10-01T10:00:00Z",
          },
        ];
        if (call.scope) call.scope.committedRevision = 1;
        return { documentId: "pol0000000000000000000a1" };
      },
    });
    const ctx = context(gateFor({ uid: POLL, intent: "create", documentId: undefined }), {
      query: {},
    });
    await authoringActionsFor(host, POLL).create(ctx);
    expect(calls[0].params.status).toBe("published");
    expect(ctx.body).toEqual({
      data: {
        documentId: "pol0000000000000000000a1",
        version: "1",
        status: "published",
        publishedAt: "2026-10-01T10:00:00.000Z",
      },
    });
  });
});

describe("discard-draft", () => {
  it("a department author without a published row: 400 neverPublished under the lock, after the token check", async () => {
    const { stub, host, calls } = harness();
    seedRows(stub, "doc0000000000000000000a1", false);
    lock.locked = 3;
    const gate = gateFor({
      intent: "discardDraft",
      roleClass: "departmentAuthor",
      classify: async () => "departmentAuthor",
    });
    const ctx = context(gate, { ifMatch: '"3"' });
    await expect(authoringActionsFor(host, A).discardDraft?.(ctx)).rejects.toMatchObject({
      details: { keys: ["_form"], codes: { _form: "neverPublished" } },
    });
    expect(lock.calls).toEqual([`${A} doc0000000000000000000a1`]);
    expect(calls).toEqual([]);
  });

  it("a stale token answers 412 (class kept) or 404 (class lost) before the discard rule", async () => {
    const { stub, host } = harness();
    seedRows(stub, "doc0000000000000000000a1", false);
    lock.locked = 5;
    const kept = context(
      gateFor({
        intent: "discardDraft",
        roleClass: "departmentAuthor",
        classify: async () => "departmentAuthor",
      }),
      { ifMatch: '"3"' },
    );
    await authoringActionsFor(host, A).discardDraft?.(kept);
    expect(kept.status).toBe(412);
    expect((kept.body as { error: { details: unknown } }).error.details).toEqual({ current: 5 });
    const lost = context(
      gateFor({
        intent: "discardDraft",
        roleClass: "departmentAuthor",
        classify: async () => null,
      }),
      { ifMatch: '"5"' },
    );
    await authoringActionsFor(host, A).discardDraft?.(lost);
    expect(lost.status).toBe(404);
    expect((lost.body as { error: { details: unknown } }).error.details).toEqual({});
  });

  it("a moderator's discard of a never-published document deletes it: 204", async () => {
    const { stub, host } = harness({
      onCall: (_call, s) => {
        s.tables[A] = [];
        return { documentId: "doc0000000000000000000a1", entries: [] };
      },
    });
    seedRows(stub, "doc0000000000000000000a1", false);
    const ctx = context(gateFor({ intent: "discardDraft" }), { ifMatch: '"3"' });
    await authoringActionsFor(host, A).discardDraft?.(ctx);
    expect(ctx.status).toBe(204);
    expect(lock.calls).toEqual([]);
  });
});

describe("delete", () => {
  it("translates a row id, needs If-Match, compares the token only and answers 204", async () => {
    const { stub, host, calls } = harness();
    seedRows(stub, "doc0000000000000000000a1", true);
    const missing = context(null, { id: "doc0000000000000000000a1" });
    await authoringActionsFor(host, A).delete(missing);
    expect(missing.status).toBe(428);
    const ctx = context(null, { id: "2", ifMatch: '"7"' });
    await authoringActionsFor(host, A).delete(ctx);
    expect(ctx.status).toBe(204);
    expect(calls[0]).toMatchObject({
      action: "delete",
      params: { documentId: "doc0000000000000000000a1" },
      scope: {
        uid: A,
        documentId: "doc0000000000000000000a1",
        expectedRevision: 7,
        missingClass: 404,
      },
    });
    expect(calls[0].scope).not.toHaveProperty("observedRevision");
    await expect(
      authoringActionsFor(host, A).delete(context(null, { id: "999", ifMatch: '"1"' })),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
  });
});

describe("the action set per type", () => {
  it("gives polls no publish, unpublish or discard", () => {
    const { host } = harness();
    for (const uid of Object.keys(AUTHORING_SPECS)) {
      const actions = authoringActionsFor(host, uid);
      const publishes = uid !== POLL;
      expect(typeof actions.publish === "function", uid).toBe(publishes);
      expect(typeof actions.unpublish === "function", uid).toBe(publishes);
      expect(typeof actions.discardDraft === "function", uid).toBe(publishes);
    }
    expect(() => authoringActionsFor(host, "api::wiki-page.wiki-page")).toThrow();
  });
});
