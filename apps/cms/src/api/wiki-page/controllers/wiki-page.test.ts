import { beforeEach, describe, expect, it, vi } from "vitest";

import { createStrapiStub } from "../../../test/strapi-stub.test.helper";
import { wikiEditContext } from "../../../utils/wiki-edit-context";
import { AUTHORING_STATE_KEY, type AuthoringGate } from "../../../utils/write-gate";

/**
 * The wiki-page controller (batch 16 lane 16B): the authoring controller's
 * actions plus the wiki's draft and history actions, every write inside
 * wikiEditContext (contract K16), so the wiki-page lifecycle records the
 * history with its editor:
 *   - `revisionSummary` is no schema attribute: the allowlist admits it as a
 *     controller field, and it leaves the payload here for the context;
 *   - the editor is the caller the gate admitted;
 *   - a restore names the revision it brings back (`restoredFrom`).
 * The Document Service is a spy that records the payload and the store it
 * runs under (the Document Service middlewares are not part of this test).
 */

const mocks = vi.hoisted(() => ({
  seen: [] as { action: string; data: unknown; store: unknown }[],
}));

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        cfg({ strapi }),
  },
}));

const UID = "api::wiki-page.wiki-page";
const DOC = "page0000000000000000000a";

beforeEach(() => {
  mocks.seen.length = 0;
});

function host() {
  const stub = createStrapiStub({
    tables: {
      [UID]: [
        {
          id: 1,
          documentId: DOC,
          title: "T",
          slug: "t-1a2b3c4d",
          publishedAt: null,
          updatedAt: "2026-10-01T10:00:00.000Z",
          publishAt: null,
          scheduleError: null,
        },
      ],
      "api::wiki-revision.wiki-revision": [
        {
          id: 7,
          pageDocumentId: DOC,
          title: "Old title",
          body: "Old body",
          pageSummary: "Old summary",
          summary: "an edit",
          kind: "after",
          createdAt: "2026-10-01T09:00:00.000Z",
        },
      ],
    },
  });
  const record =
    (action: string) =>
    async (params: Record<string, unknown>): Promise<unknown> => {
      mocks.seen.push({
        action,
        data: structuredClone(params.data),
        store: structuredClone(wikiEditContext.getStore()),
      });
      return { documentId: (params.documentId as string) ?? DOC };
    };
  const documents = () => ({
    create: record("create"),
    update: record("update"),
    publish: record("publish"),
    unpublish: record("unpublish"),
    discardDraft: record("discardDraft"),
    delete: record("delete"),
  });
  return { ...stub, documents };
}

const gate = (intent: AuthoringGate["intent"]): AuthoringGate => ({
  uid: UID,
  intent,
  roleClass: "author",
  callerId: 42,
  callerDepartment: null,
  ...(intent === "create" || intent === "createDraft"
    ? {}
    : { documentId: DOC, observedRevision: 3, classify: async () => "author" }),
});

function ctx(
  intent: AuthoringGate["intent"],
  options: { query?: Record<string, unknown>; body?: unknown } = {},
) {
  return {
    state: { [AUTHORING_STATE_KEY]: gate(intent) },
    params: { id: DOC },
    query: options.query ?? {},
    request: {
      body: options.body ?? { data: { title: "New", revisionSummary: "Fixed a typo" } },
    },
    get: (name: string) => (name.toLowerCase() === "if-match" ? '"3"' : ""),
    set: () => undefined,
    status: 404,
    body: null as unknown,
  };
}

async function controller() {
  const factory = (await import("./wiki-page")).default as unknown as (deps: {
    strapi: unknown;
  }) => Record<string, (ctx: unknown) => Promise<void>>;
  return factory({ strapi: host() });
}

describe("wiki-page controller", () => {
  it("serves the authoring actions and the draft and history actions", async () => {
    const actions = await controller();
    for (const name of [
      "create",
      "update",
      "delete",
      "publish",
      "unpublish",
      "discardDraft",
      "authoringList",
      "editable",
      "createDraft",
      "saveDraft",
      "myDrafts",
      "revisions",
      "revision",
      "restore",
    ]) {
      expect(typeof actions[name], name).toBe("function");
    }
  });

  it("runs update inside wikiEditContext, revisionSummary out of the payload", async () => {
    const actions = await controller();
    const request = ctx("update", { query: { status: "published" } });
    await actions.update(request);
    expect(request.status).toBe(200);
    expect(mocks.seen).toEqual([
      {
        action: "update",
        data: { title: "New" },
        store: { editorId: 42, revisionSummary: "Fixed a typo" },
      },
    ]);
  });

  it("runs create, createDraft and saveDraft inside it too; the draft actions save drafts only", async () => {
    const actions = await controller();
    await actions.create(ctx("create", { query: { status: "draft" } }));
    const created = ctx("createDraft");
    await actions.createDraft(created);
    const saved = ctx("saveDraft");
    await actions.saveDraft(saved);
    expect(created.status).toBe(201);
    expect(saved.status).toBe(200);
    expect(mocks.seen.map(({ action, store }) => ({ action, store }))).toEqual([
      { action: "create", store: { editorId: 42, revisionSummary: "Fixed a typo" } },
      { action: "create", store: { editorId: 42, revisionSummary: "Fixed a typo" } },
      { action: "update", store: { editorId: 42, revisionSummary: "Fixed a typo" } },
    ]);
    for (const seen of mocks.seen) expect(seen.data).toEqual({ title: "New" });
  });

  it("refuses any query on the draft actions", async () => {
    const actions = await controller();
    await expect(
      actions.saveDraft(ctx("saveDraft", { query: { status: "published" } })),
    ).rejects.toThrow();
    expect(mocks.seen).toEqual([]);
  });

  it("restores a revision: the draft update and the publish, both recorded with restoredFrom", async () => {
    const actions = await controller();
    const request = ctx("restore", { body: { revisionId: 7 } });
    await actions.restore(request);
    expect(request.status).toBe(200);
    expect(mocks.seen).toEqual([
      {
        action: "update",
        data: { title: "Old title", body: "Old body", summary: "Old summary", lastEditor: 42 },
        store: { editorId: 42, restoredFrom: 7 },
      },
      { action: "publish", data: undefined, store: { editorId: 42, restoredFrom: 7 } },
    ]);
  });

  it("answers 404 for a revision of another page, and 400 for a body that is not { revisionId }", async () => {
    const actions = await controller();
    await expect(actions.restore(ctx("restore", { body: { revisionId: 99 } }))).rejects.toThrow(
      "Not Found",
    );
    await expect(
      actions.restore(ctx("restore", { body: { revisionId: 7, title: "x" } })),
    ).rejects.toThrow();
    await expect(actions.restore(ctx("restore", { body: { revisionId: "7a" } }))).rejects.toThrow();
    expect(mocks.seen).toEqual([]);
  });
});
