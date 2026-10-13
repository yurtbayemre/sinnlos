import { beforeEach, describe, expect, it, vi } from "vitest";

import { deleteAuditContext } from "./delete-audit";
import {
  MEDIA_CLAIM_FIELDS,
  attachVerdict,
  attachedFiles,
  createMediaClaims,
  releasedFiles,
  type DocumentLinks,
} from "./media-claims";

/**
 * File claims (decision 06 §E3, §E4; batch 16 plan item 3, contract K12):
 * the attach decision under the lock, the release after the commit, per
 * action, with a stub lock and a stub link table.
 */

const mocks = vi.hoisted(() => ({
  claimAndRemove: vi.fn(async (_strapi: unknown, _id: number) => "removed"),
  contexts: [] as unknown[],
}));

vi.mock("./upload-orphans", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./upload-orphans")>()),
  claimAndRemove: mocks.claimAndRemove,
}));

const UID = "api::document.document";
const PDF = "application/pdf";
const links = (rowIds: number[], files: Array<[number, string]>): DocumentLinks => ({
  rowIds,
  files: new Map(files),
});

describe("attachedFiles / releasedFiles", () => {
  it("a draft-only replace attaches the new file and keeps the published one", () => {
    const before = links([1, 2], [[10, "file"]]);
    const after = links(
      [1, 2],
      [
        [10, "file"],
        [11, "file"],
      ],
    );
    expect(attachedFiles(before, after)).toEqual([11]);
    expect(releasedFiles(before, after)).toEqual([]);
  });

  it("a publish of a replaced file releases the old one", () => {
    expect(
      releasedFiles(
        links(
          [1, 2],
          [
            [10, "file"],
            [11, "file"],
          ],
        ),
        links([1, 3], [[11, "file"]]),
      ),
    ).toEqual([10]);
  });

  it("a delete releases every file; retaining is no attachment", () => {
    expect(releasedFiles(links([1], [[10, "file"]]), links([], []))).toEqual([10]);
    expect(attachedFiles(links([1], [[10, "file"]]), links([1], [[10, "file"]]))).toEqual([]);
  });
});

describe("attachVerdict (under the lock)", () => {
  const base = {
    links: [{ relatedType: UID, relatedId: 1 }],
    uid: UID,
    ownRowIds: [1, 2],
    callerId: 7,
    mimes: MEDIA_CLAIM_FIELDS[UID].file,
  };
  const file = (extra: Record<string, unknown> = {}) => ({
    id: 10,
    mime: PDF,
    provider_metadata: { uploadedBy: 7 },
    ...extra,
  });

  it("accepts the caller's own upload linked only by this document", () => {
    expect(attachVerdict({ ...base, file: file() })).toBe("ok");
  });

  it("leaves an unstamped panel upload unclaimed (no check, never removed)", () => {
    expect(attachVerdict({ ...base, file: file({ provider_metadata: null }), callerId: 7 })).toBe(
      "unclaimed",
    );
  });

  it.each([
    ["a missing file", null],
    ["another user's upload", file({ provider_metadata: { uploadedBy: 8 } })],
    ["a mime off the field's list", file({ mime: "image/gif" })],
    [
      "a tombstoned file",
      file({ provider_metadata: { uploadedBy: 7, removing: "2026-10-13T00:00:00Z" } }),
    ],
  ])("refuses %s", (_label, candidate) => {
    expect(attachVerdict({ ...base, file: candidate })).toBe("refuse");
  });

  it("refuses a file another document or type links", () => {
    expect(
      attachVerdict({
        ...base,
        file: file(),
        links: [...base.links, { relatedType: UID, relatedId: 99 }],
      }),
    ).toBe("refuse");
    expect(
      attachVerdict({
        ...base,
        file: file(),
        links: [{ relatedType: "api::classified.classified", relatedId: 1 }],
      }),
    ).toBe("refuse");
  });

  it("checks no stamp or mime without a users-permissions caller (panel, scheduler)", () => {
    expect(
      attachVerdict({
        ...base,
        file: file({ provider_metadata: { uploadedBy: 8 }, mime: "x/y" }),
        callerId: null,
      }),
    ).toBe("ok");
  });
});

/** A fake strapi for the middleware: rows and links that `next()` changes. */
function makeStrapi(state: {
  rows: Record<string, number[]>;
  links: Array<{ file_id: number; field: string; related_id: number; related_type: string }>;
  files: Record<number, Record<string, unknown>>;
  ctx?: unknown;
}) {
  const log: string[] = [];
  const commitCallbacks: Array<() => unknown> = [];
  let open = false;
  const linkQuery = () => {
    const filters: { field?: string[]; related?: number[]; fileId?: number; type?: string } = {};
    const builder: any = {
      transacting: () => builder,
      where: (clause: Record<string, unknown>) => {
        if (clause.related_type) filters.type = clause.related_type as string;
        if (clause.file_id !== undefined) filters.fileId = clause.file_id as number;
        return builder;
      },
      whereIn: (column: string, values: unknown[]) => {
        if (column === "related_id") filters.related = values as number[];
        if (column === "field") filters.field = values as string[];
        return builder;
      },
      select: async () =>
        state.links
          .filter(
            (link) =>
              (filters.type === undefined || link.related_type === filters.type) &&
              (filters.related === undefined || filters.related.includes(link.related_id)) &&
              (filters.field === undefined || filters.field.includes(link.field)) &&
              (filters.fileId === undefined || link.file_id === filters.fileId),
          )
          .map((link) => ({ ...link })),
    };
    return builder;
  };
  const strapi = {
    log: { error: vi.fn() },
    requestContext: { get: () => state.ctx },
    db: {
      inTransaction: () => open,
      transaction: async (cb: (scope: unknown) => Promise<unknown>) => {
        const outer = open;
        open = true;
        try {
          return await cb({
            trx: "trx",
            onCommit: (fn: () => unknown) => commitCallbacks.push(fn),
            onRollback: () => undefined,
          });
        } finally {
          open = outer;
        }
      },
      getConnection: () => linkQuery(),
      queryBuilder: () => {
        const qb: any = {
          select: () => qb,
          where: (where: { id: number }) => {
            log.push(`lock:${where.id}`);
            return qb;
          },
          forUpdate: () => qb,
          execute: async () => [],
        };
        return qb;
      },
      query: (uid: string) => ({
        findMany: async ({ where }: { where: { documentId: string } }) =>
          (state.rows[where.documentId] ?? []).map((id) => ({ id, uid })),
        findOne: async ({ where }: { where: { id: number } }) => state.files[where.id] ?? null,
      }),
    },
  };
  const commit = async () => {
    for (const cb of commitCallbacks.splice(0)) await cb();
  };
  return { strapi, log, commit, commitCallbacks };
}

const link = (file_id: number, related_id: number, related_type = UID) => ({
  file_id,
  related_id,
  related_type,
  field: "file",
});
const editor = {
  state: {
    auth: { strategy: { name: "users-permissions" } },
    user: { id: 7, role: { type: "editor" } },
  },
};

beforeEach(() => {
  mocks.contexts.length = 0;
  mocks.claimAndRemove.mockReset().mockImplementation(async () => {
    mocks.contexts.push(deleteAuditContext());
    return "removed";
  });
});

describe("createMediaClaims: the middleware", () => {
  it("passes other uids and reads through untouched", async () => {
    const { strapi } = makeStrapi({ rows: {}, links: [], files: {} });
    const next = vi.fn(async () => "result");
    const claims = createMediaClaims(strapi);
    expect(await claims({ uid: "api::event.event", action: "update", params: {} }, next)).toBe(
      "result",
    );
    expect(await claims({ uid: UID, action: "findOne", params: {} }, next)).toBe("result");
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("an update that attaches the caller's own file locks it and passes", async () => {
    const state = {
      rows: { d1: [1, 2] },
      links: [link(10, 1), link(10, 2)],
      files: { 11: { id: 11, mime: PDF, provider_metadata: { uploadedBy: 7 } } },
      ctx: editor,
    };
    const { strapi, log, commit } = makeStrapi(state);
    const result = await createMediaClaims(strapi)(
      { uid: UID, action: "update", params: { documentId: "d1" } },
      async () => {
        state.links = [link(11, 1), link(10, 2)];
        return { documentId: "d1" };
      },
    );
    expect(result).toEqual({ documentId: "d1" });
    expect(log).toEqual(["lock:11"]);
    await commit();
    expect(mocks.claimAndRemove).not.toHaveBeenCalled();
  });

  it("refuses a foreign file with the allowlist's `invalid` on the field", async () => {
    const state = {
      rows: { d1: [1] },
      links: [] as ReturnType<typeof link>[],
      files: { 11: { id: 11, mime: PDF, provider_metadata: { uploadedBy: 7 } } },
      ctx: editor,
    };
    const { strapi } = makeStrapi(state);
    await expect(
      createMediaClaims(strapi)(
        { uid: UID, action: "update", params: { documentId: "d1" } },
        async () => {
          state.links = [link(11, 1), link(11, 99)];
          return { documentId: "d1" };
        },
      ),
    ).rejects.toMatchObject({ name: "ValidationError", details: { keys: ["file"] } });
  });

  it("a publish releases the replaced file after the commit, linked to the document", async () => {
    const state = {
      rows: { d1: [1, 2] } as Record<string, number[]>,
      links: [link(11, 1), link(10, 2)],
      files: {},
      ctx: editor,
    };
    const { strapi, commit } = makeStrapi(state);
    await createMediaClaims(strapi)(
      { uid: UID, action: "publish", params: { documentId: "d1" } },
      async () => {
        state.rows = { d1: [1, 3] };
        state.links = [link(11, 1), link(11, 3)];
        return { documentId: "d1" };
      },
    );
    expect(mocks.claimAndRemove).not.toHaveBeenCalled();
    await commit();
    expect(mocks.claimAndRemove.mock.calls.map((call) => call[1])).toEqual([10]);
    expect(mocks.contexts).toEqual([{ related: { uid: UID, documentId: "d1" } }]);
  });

  it("a delete releases the document's files", async () => {
    const state = {
      rows: { d1: [1] } as Record<string, number[]>,
      links: [link(10, 1)],
      files: {},
      ctx: undefined,
    };
    const { strapi, commit } = makeStrapi(state);
    await createMediaClaims(strapi)(
      { uid: UID, action: "delete", params: { documentId: "d1" } },
      async () => {
        state.rows = {};
        state.links = [];
        return { documentId: "d1" };
      },
    );
    await commit();
    expect(mocks.claimAndRemove.mock.calls.map((call) => call[1])).toEqual([10]);
  });

  it("a panel clone shares the source's file: no attach check, nothing released", async () => {
    const state = {
      rows: { src: [1] } as Record<string, number[]>,
      links: [link(10, 1)],
      files: { 10: { id: 10, mime: PDF, provider_metadata: { uploadedBy: 8 } } },
      ctx: { state: { auth: { strategy: { name: "admin" } }, user: { id: 1 } } },
    };
    const { strapi, log, commit } = makeStrapi(state);
    await createMediaClaims(strapi)(
      { uid: UID, action: "clone", params: { documentId: "src" } },
      async () => {
        state.rows.copy = [5];
        state.links = [link(10, 1), link(10, 5)];
        return { documentId: "copy" };
      },
    );
    expect(log).toEqual([]);
    await commit();
    expect(mocks.claimAndRemove).not.toHaveBeenCalled();
  });

  it("a create checks every file the new document links", async () => {
    const state = {
      rows: {} as Record<string, number[]>,
      links: [] as ReturnType<typeof link>[],
      files: { 12: { id: 12, mime: "image/gif", provider_metadata: { uploadedBy: 7 } } },
      ctx: editor,
    };
    const { strapi } = makeStrapi(state);
    await expect(
      createMediaClaims(strapi)(
        { uid: UID, action: "create", params: { data: { file: 12 } } },
        async () => {
          state.rows.n1 = [6];
          state.links = [link(12, 6)];
          return { documentId: "n1" };
        },
      ),
    ).rejects.toMatchObject({ details: { keys: ["file"] } });
  });
});

describe("payloadFileIds and the lock before the action", () => {
  it("reads ids, { id }, lists and connect/set, per claimed field, ascending", async () => {
    const { payloadFileIds } = await import("./media-claims");
    expect([...payloadFileIds({ file: 7, title: 3 }, ["file"])]).toEqual([[7, "file"]]);
    expect([...payloadFileIds({ file: { id: "9" } }, ["file"])]).toEqual([[9, "file"]]);
    expect([...payloadFileIds({ file: { connect: [{ id: 5 }, 2] } }, ["file"])]).toEqual([
      [2, "file"],
      [5, "file"],
    ]);
    expect([...payloadFileIds({ file: { set: [{ id: 4 }] } }, ["file"])]).toEqual([[4, "file"]]);
    expect([...payloadFileIds({ file: null }, ["file"])]).toEqual([]);
    expect([...payloadFileIds({ file: "abc" }, ["file"])]).toEqual([]);
    expect([...payloadFileIds(undefined, ["file"])]).toEqual([]);
  });

  it("locks the payload's files before the action and refuses a missing or tombstoned one", async () => {
    const tombstoned = {
      rows: { d1: [1] },
      links: [] as ReturnType<typeof link>[],
      files: {
        11: {
          id: 11,
          mime: PDF,
          provider_metadata: { uploadedBy: 7, removing: "2026-10-13T00:00:00Z" },
        },
      },
      ctx: editor,
    };
    const { strapi, log } = makeStrapi(tombstoned);
    const next = vi.fn(async () => ({ documentId: "d1" }));
    await expect(
      createMediaClaims(strapi)(
        { uid: UID, action: "update", params: { documentId: "d1", data: { file: 11 } } },
        next,
      ),
    ).rejects.toMatchObject({ details: { keys: ["file"] } });
    expect(log).toEqual(["lock:11"]);
    expect(next).not.toHaveBeenCalled();
    const missing = makeStrapi({ ...tombstoned, files: {} });
    await expect(
      createMediaClaims(missing.strapi)(
        { uid: UID, action: "update", params: { documentId: "d1", data: { file: 12 } } },
        next,
      ),
    ).rejects.toMatchObject({ details: { keys: ["file"] } });
    expect(next).not.toHaveBeenCalled();
  });
});
