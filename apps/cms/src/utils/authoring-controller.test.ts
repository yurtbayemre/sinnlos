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
        const details = (error as InstanceType<typeof errors.ValidationError>).details as {
          keys?: string[];
        };
        expect(details?.keys, JSON.stringify(query)).toEqual(keys);
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
    // Byte-identical to the gate's refusal (Strapi's PolicyError).
    expect(lostCtx.body).toEqual({
      data: null,
      error: { status: 403, name: "PolicyError", message: "Policy Failed", details: {} },
    });
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

  it("a lost class answers 404 with current tokens too, before the discard rule (K2, 15B a3bfd5c)", async () => {
    const { stub, host, calls } = harness();
    seedRows(stub, "doc0000000000000000000a1", false);
    lock.locked = 3;
    const classify = vi.fn(async () => null);
    const ctx = context(
      gateFor({ intent: "discardDraft", roleClass: "departmentAuthor", classify }),
      {
        ifMatch: '"3"',
      },
    );
    await authoringActionsFor(host, A).discardDraft?.(ctx);
    expect(ctx.status).toBe(404);
    expect((ctx.body as { error: { details: unknown } }).error.details).toEqual({});
    expect(classify).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
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

describe("authoringList", () => {
  const VERSION = "api::content-version.content-version";
  const DOC = "doc0000000000000000000a1";
  const listed = (query: Record<string, unknown> = {}) => {
    const { stub, host } = harness();
    seedRows(stub, DOC, true);
    stub.tables[VERSION] = [{ id: 1, targetUid: A, targetDocumentId: DOC, revision: 5 }];
    const ctx = context(gateFor({ intent: "authoringList", documentId: undefined }), { query });
    const reads = () =>
      stub.calls.filter((call) => call.api === "db" && call.method === "findMany");
    return { ctx, reads, run: () => authoringActionsFor(host, A).authoringList(ctx) };
  };

  it("the full path (a status filter) reads the versions before the rows", async () => {
    const { ctx, reads, run } = listed({ status: "published" });
    await run();
    expect(ctx.status).toBe(200);
    expect((ctx.body as { data: { version: string }[] }).data).toMatchObject([{ version: "5" }]);
    expect(reads().map((call) => call.uid)).toEqual([VERSION, A, A]);
    expect(reads()[0].params).toEqual({
      where: { targetUid: A },
      select: ["targetDocumentId", "revision"],
    });
  });

  it("the light path (#170): the page's ids, then their versions, then their rows in full", async () => {
    const { ctx, reads, run } = listed();
    await run();
    expect(ctx.status).toBe(200);
    expect(ctx.body).toMatchObject({
      data: [{ documentId: DOC, version: "5", status: "published" }],
      meta: { pagination: { total: 1 } },
    });
    expect(reads().map((call) => call.uid)).toEqual([A, VERSION, A, A]);
    expect(reads()[0].params).toEqual({
      where: { publishedAt: { $null: true } },
      select: ["documentId", "updatedAt", "title"],
    });
    expect(reads()[1].params).toMatchObject({
      where: { targetUid: A, targetDocumentId: { $in: [DOC] } },
    });
    expect(reads()[2].params).toMatchObject({
      where: { documentId: { $in: [DOC] }, publishedAt: { $null: true } },
    });
  });

  it("the light path reads versions, drafts and twins of the page's documents only", async () => {
    const { stub, host } = harness();
    const ids = Array.from({ length: 26 }, (_, i) => `doc${String(i).padStart(21, "0")}`);
    // Older first: ids[0] is the oldest draft, so page 2 holds it alone.
    stub.tables[A] = ids.flatMap((documentId, i) => [
      {
        id: 2 * i + 1,
        documentId,
        title: `T${i}`,
        publishedAt: null,
        updatedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
      },
      {
        id: 2 * i + 2,
        documentId,
        title: `T${i}`,
        publishedAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
    stub.tables[VERSION] = [];
    const ctx = context(gateFor({ intent: "authoringList", documentId: undefined }), {
      query: { page: "2" },
    });
    await authoringActionsFor(host, A).authoringList(ctx);
    expect(ctx.body).toMatchObject({
      data: [{ documentId: ids[0], status: "modified" }],
      meta: { pagination: { page: 2, pageCount: 2, total: 26 } },
    });
    const reads = stub.calls.filter((call) => call.api === "db" && call.method === "findMany");
    expect(reads.map((call) => call.uid)).toEqual([A, VERSION, A, A]);
    for (const call of reads.slice(1)) {
      expect(call.params).toMatchObject({
        where: expect.objectContaining({
          [call.uid === VERSION ? "targetDocumentId" : "documentId"]: { $in: [ids[0]] },
        }),
      });
    }
  });

  it("the light path reads no versions and no rows for a page past the end", async () => {
    const { ctx, reads, run } = listed({ page: "2" });
    await run();
    expect(ctx.body).toMatchObject({ data: [], meta: { pagination: { page: 2, total: 1 } } });
    expect(reads().map((call) => call.uid)).toEqual([A]);
  });
});

describe("the action set per type", () => {
  it("gives polls and wiki spaces (always published) no publish, unpublish or discard", () => {
    const { host } = harness();
    for (const uid of Object.keys(AUTHORING_SPECS)) {
      const actions = authoringActionsFor(host, uid);
      const publishes = uid !== POLL && uid !== "api::wiki-space.wiki-space";
      expect(typeof actions.publish === "function", uid).toBe(publishes);
      expect(typeof actions.unpublish === "function", uid).toBe(publishes);
      expect(typeof actions.discardDraft === "function", uid).toBe(publishes);
    }
    expect(Object.keys(AUTHORING_SPECS)).toContain("api::wiki-page.wiki-page");
    expect(() => authoringActionsFor(host, "api::wiki-revision.wiki-revision")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The wiki (batch 16, lane 16B) and editable.authorName (S13)

const SPACE = "api::wiki-space.wiki-space";
const WIKI = "api::wiki-page.wiki-page";
const PAGE_DOC = "page0000000000000000000a";
const SPACE_DOC = "spce0000000000000000000a";

const pageRow = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  documentId: PAGE_DOC,
  title: "Handbook",
  slug: "handbook-1a2b3c4d",
  body: "# Hi",
  summary: null,
  tags: ["hr", 3],
  tocEnabled: null,
  order: 2,
  publishedAt: null,
  updatedAt: "2026-10-01T10:00:00.000Z",
  publishAt: null,
  scheduleError: null,
  author: { id: 5, displayName: "Ada" },
  department: { id: 10, documentId: "dept000000000000000000ab" },
  team: null,
  space: { id: 20, documentId: SPACE_DOC, slug: "hand", name: "Handbook space" },
  parent: { id: 9, documentId: "prnt0000000000000000000a" },
  ...overrides,
});

describe("the wiki in the authoring controller", () => {
  it("answers a wiki-page form in the write shape, the moderator fields for moderators only", async () => {
    const { host } = harness();
    const rows = { documentId: PAGE_DOC, draft: pageRow(), published: null };
    for (const roleClass of ["author", "departmentHead", "moderator"] as const) {
      const ctx = context(
        gateFor({ uid: WIKI, intent: "editable", roleClass, documentId: PAGE_DOC, rows }),
      );
      await authoringActionsFor(host, WIKI).editable(ctx);
      const data = (ctx.body as { data: Record<string, unknown> }).data;
      expect(data, roleClass).toMatchObject({
        documentId: PAGE_DOC,
        roleClass,
        authorName: "Ada",
        title: "Handbook",
        slug: "handbook-1a2b3c4d",
        tags: ["hr"],
        tocEnabled: true,
        order: 2,
        space: { documentId: SPACE_DOC, slug: "hand", name: "Handbook space" },
        parent: "prnt0000000000000000000a",
        canDiscardUnpublished: roleClass !== "departmentHead",
      });
      for (const key of ["department", "team", "publishAt", "scheduleError"]) {
        expect(key in data, `${roleClass} ${key}`).toBe(roleClass === "moderator");
      }
    }
  });

  it("names the author on every type's form (S13), null for quick links", async () => {
    const { host } = harness();
    const author = { id: 5, displayName: "", username: "ada" };
    const draft = {
      id: 1,
      documentId: "doc0000000000000000000a1",
      title: "T",
      publishedAt: null,
      updatedAt: "2026-10-01T10:00:00.000Z",
      author,
      organizer: author,
      uploadedBy: author,
    };
    for (const [uid, expected] of [
      [A, "ada"],
      ["api::event.event", "ada"],
      ["api::document.document", "ada"],
      ["api::quick-link.quick-link", null],
    ] as const) {
      const ctx = context(
        gateFor({
          uid,
          intent: "editable",
          rows: { documentId: draft.documentId, draft, published: null },
        }),
      );
      await authoringActionsFor(host, uid).editable(ctx);
      expect((ctx.body as { data: { authorName: unknown } }).data.authorName, uid).toBe(expected);
    }
  });

  it("answers a wiki-space form with its page count and a lost visibility target", async () => {
    const { stub, host } = harness();
    stub.tables[WIKI] = [
      { id: 1, documentId: "pga000000000000000000000", space: { id: 20 }, publishedAt: null },
      { id: 2, documentId: "pga000000000000000000000", space: { id: 21 }, publishedAt: "x" },
      { id: 3, documentId: "pgb000000000000000000000", space: { id: 20 }, publishedAt: null },
    ];
    stub.tables[SPACE] = [
      { id: 20, documentId: SPACE_DOC, publishedAt: null },
      { id: 21, documentId: SPACE_DOC, publishedAt: "x" },
    ];
    const draft = {
      id: 20,
      documentId: SPACE_DOC,
      name: "Ops",
      slug: "ops-12345678",
      icon: "book",
      description: null,
      visibility: "department",
      department: null,
      team: null,
      allowedRoles: [],
      publishedAt: null,
      updatedAt: "2026-10-01T10:00:00.000Z",
    };
    const ctx = context(
      gateFor({
        uid: SPACE,
        intent: "editable",
        documentId: SPACE_DOC,
        rows: { documentId: SPACE_DOC, draft, published: null },
      }),
    );
    await authoringActionsFor(host, SPACE).editable(ctx);
    expect((ctx.body as { data: unknown }).data).toMatchObject({
      name: "Ops",
      slug: "ops-12345678",
      icon: "book",
      visibility: "department",
      allowedRoles: [],
      department: null,
      needsRetarget: true,
      pageCount: 2,
      authorName: null,
    });
  });

  it("takes `space` on the wiki-page list and no status on the wiki-space list", () => {
    expect(parseListQuery({ space: SPACE_DOC, status: "draft" }, { space: true })).toEqual({
      page: 1,
      status: "draft",
      space: SPACE_DOC,
    });
    for (const [query, keys] of [
      [{ space: "x y" }, { space: true }],
      [{ space: SPACE_DOC }, {}],
      [{ status: "draft" }, { status: false }],
    ] as const) {
      expect(
        () => parseListQuery(query as Record<string, unknown>, keys),
        JSON.stringify(query),
      ).toThrow(errors.ValidationError);
    }
  });

  it("answers wiki writes with the slug, a page with its space's slug", async () => {
    const { stub, host } = harness({
      onCall: (call) => {
        if (call.scope) call.scope.committedRevision = 2;
        return { documentId: PAGE_DOC };
      },
    });
    stub.tables[WIKI] = [
      {
        id: 1,
        documentId: PAGE_DOC,
        slug: "handbook-1a2b3c4d",
        publishedAt: null,
        updatedAt: "2026-10-01T10:00:00.000Z",
        publishAt: null,
        scheduleError: null,
        space: { id: 20 },
      },
    ];
    stub.tables[SPACE] = [{ id: 20, documentId: SPACE_DOC, slug: "hand", publishedAt: null }];
    const ctx = context(gateFor({ uid: WIKI, roleClass: "author", documentId: PAGE_DOC }), {
      query: { status: "published" },
      ifMatch: '"1"',
      body: { data: { title: "x", revisionSummary: "note" } },
    });
    await authoringActionsFor(host, WIKI).update(ctx);
    expect((ctx.body as { data: unknown }).data).toEqual({
      documentId: PAGE_DOC,
      version: "2",
      status: "draft",
      publishedAt: null,
      publishAt: null,
      scheduleError: null,
      slug: "handbook-1a2b3c4d",
      spaceSlug: "hand",
    });
  });

  it("a wiki page without a published row: its author and moderators discard (delete), the others get 404 under the lock", async () => {
    for (const [roleClass, outcome] of [
      ["departmentHead", 404],
      ["teamLead", 404],
      ["author", 204],
      ["moderator", 204],
    ] as const) {
      lock.locked = 3;
      lock.calls.length = 0;
      const { stub, host, calls } = harness({
        onCall: (_call, s) => {
          s.tables[WIKI] = [];
          return { documentId: PAGE_DOC, entries: [] };
        },
      });
      stub.tables[WIKI] = [pageRow()];
      const ctx = context(
        gateFor({
          uid: WIKI,
          intent: "discardDraft",
          roleClass,
          documentId: PAGE_DOC,
          classify: async () => roleClass,
        }),
        { ifMatch: '"3"' },
      );
      await authoringActionsFor(host, WIKI).discardDraft?.(ctx);
      expect(ctx.status, roleClass).toBe(outcome);
      expect(calls.length, roleClass).toBe(outcome === 204 ? 1 : 0);
      // Decided under the lock for the classes that may not delete.
      expect(lock.calls.length, roleClass).toBe(outcome === 404 ? 1 : 0);
    }
  });

  it("lets a department head discard a page that has a published row", async () => {
    lock.locked = 3;
    const { stub, host, calls } = harness();
    stub.tables[WIKI] = [pageRow(), pageRow({ id: 2, publishedAt: "2026-10-01T10:00:00.000Z" })];
    const ctx = context(
      gateFor({
        uid: WIKI,
        intent: "discardDraft",
        roleClass: "departmentHead",
        documentId: PAGE_DOC,
        classify: async () => "departmentHead",
      }),
      { ifMatch: '"3"' },
    );
    await authoringActionsFor(host, WIKI).discardDraft?.(ctx);
    expect(ctx.status).toBe(200);
    expect(calls.map((call) => call.action)).toEqual(["discardDraft"]);
  });
});

const COURSE = "api::course.course";
const LESSON = "api::lesson.lesson";
const COURSE_DOC = "course000000000000000001";
const LESSON_DOC = "lesson000000000000000001";

describe("training authoring", () => {
  it("projects the fixed author DTO, including answer keys and the draft course reference", async () => {
    const { host } = harness();
    const course = {
      id: 10,
      documentId: COURSE_DOC,
      title: "Course",
      slug: "course",
      publishedAt: null,
    };
    const quiz = [{ question: "Choose?", options: ["A", "B"], correctIndex: 1 }];
    const ctx = context(
      gateFor({
        uid: LESSON,
        intent: "editable",
        rows: {
          documentId: LESSON_DOC,
          draft: {
            id: 1,
            documentId: LESSON_DOC,
            title: "Lesson",
            course,
            quiz,
            order: 3,
            videoUrl: null,
            publishedAt: null,
          },
          published: null,
        },
      }),
    );
    await authoringActionsFor(host, LESSON).editable(ctx);
    expect(ctx.body).toMatchObject({
      data: {
        title: "Lesson",
        order: 3,
        quiz,
        body: null,
        videoUrl: null,
        course: { documentId: COURSE_DOC, title: "Course", slug: "course" },
        publishAt: null,
        scheduleError: null,
        roleClass: "moderator",
      },
    });
    const coverImage = {
      id: 7,
      name: "cover",
      mime: "image/png",
      size: 1,
      url: "/cover",
      uploadedBy: 99,
    };
    const courseCtx = context(
      gateFor({
        uid: COURSE,
        intent: "editable",
        rows: {
          documentId: COURSE_DOC,
          draft: { ...course, mandatory: false, completionMode: "exam", coverImage },
          published: null,
        },
      }),
    );
    await authoringActionsFor(host, COURSE).editable(courseCtx);
    expect(courseCtx.body).toMatchObject({
      data: {
        title: "Course",
        slug: "course",
        mandatory: false,
        completionMode: "exam",
        coverImage: { id: 7, name: "cover", mime: "image/png", size: 1, url: "/cover" },
      },
    });
    expect(JSON.stringify(courseCtx.body)).not.toContain("uploadedBy");
  });

  it("validates course filters and applies them in the database before pagination/count", async () => {
    expect(parseListQuery({ course: COURSE_DOC }, { course: true })).toEqual({
      page: 1,
      course: COURSE_DOC,
    });
    for (const course of ["123", "unknown", [COURSE_DOC], { documentId: COURSE_DOC }]) {
      expect(() => parseListQuery({ course }, { course: true })).toThrow(errors.ValidationError);
    }
    expect(() => parseListQuery({ course: COURSE_DOC }, {})).toThrow(errors.ValidationError);
    const { host, stub } = harness();
    stub.tables[COURSE] = [{ id: 10, documentId: COURSE_DOC, title: "Course", slug: "course" }];
    stub.tables[LESSON] = [
      {
        id: 1,
        documentId: LESSON_DOC,
        title: "One",
        order: 4,
        course: { id: 10 },
        publishedAt: null,
      },
      {
        id: 2,
        documentId: "lesson000000000000000002",
        title: "Other",
        course: { id: 11, documentId: "course000000000000000002" },
        publishedAt: null,
      },
    ];
    const ctx = context(gateFor({ uid: LESSON, intent: "authoringList" }), {
      query: { course: COURSE_DOC },
    });
    await authoringActionsFor(host, LESSON).authoringList(ctx);
    expect(ctx.body).toMatchObject({
      data: [{ documentId: LESSON_DOC, order: 4, course: { documentId: COURSE_DOC } }],
      meta: { pagination: { total: 1 } },
    });
    const read = stub.calls.find((call) => call.uid === LESSON && call.method === "findMany");
    expect(read?.params).toMatchObject({ where: { course: { documentId: COURSE_DOC } } });
    expect(read?.params).not.toHaveProperty("select.quiz");
  });

  it.each([COURSE, LESSON])("never deletes %s by discard, even for moderators", async (uid) => {
    const { host, stub, calls } = harness();
    const documentId = uid === COURSE ? COURSE_DOC : LESSON_DOC;
    stub.tables[uid] = [{ id: 1, documentId, title: "Draft", publishedAt: null }];
    lock.locked = 3;
    const ctx = context(gateFor({ uid, documentId, intent: "discardDraft" }), { ifMatch: '"3"' });
    await expect(authoringActionsFor(host, uid).discardDraft?.(ctx)).rejects.toMatchObject({
      details: { keys: ["_form"], codes: { _form: "neverPublished" } },
    });
    expect(calls).toEqual([]);
    expect(lock.calls).toEqual([`${uid} ${documentId}`]);
    expect(stub.tables[uid]).toHaveLength(1);
  });

  it("checks the class and token before revealing training discard availability", async () => {
    const { host, stub } = harness();
    stub.tables[COURSE] = [{ id: 1, documentId: COURSE_DOC, title: "Draft", publishedAt: null }];
    lock.locked = 4;
    const stale = context(
      gateFor({ uid: COURSE, documentId: COURSE_DOC, intent: "discardDraft" }),
      { ifMatch: '"3"' },
    );
    await authoringActionsFor(host, COURSE).discardDraft?.(stale);
    expect(stale.status).toBe(412);
    const lost = context(
      gateFor({
        uid: COURSE,
        documentId: COURSE_DOC,
        intent: "discardDraft",
        classify: async () => null,
      }),
      { ifMatch: '"3"' },
    );
    await authoringActionsFor(host, COURSE).discardDraft?.(lost);
    expect(lost.status).toBe(404);
  });
});
