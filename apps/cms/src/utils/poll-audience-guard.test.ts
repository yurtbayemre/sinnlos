import { describe, expect, it, vi } from "vitest";
import { isPollTargeted } from "./poll-audience";
import {
  affectedDocumentIds,
  createPollAudienceGuard,
  POLL_AUDIENCE_GUARD_CHUNK,
  POLL_WRITE_ACTIONS,
  registerPollAudienceGuard,
  type DocumentMiddlewareContext,
  type PollAudienceGuardHost,
} from "./poll-audience-guard";

/**
 * Write-time poll audience guard (decision 02, fail closed; Codex review
 * finding 1): after every Document Service write of a poll, in the same
 * transaction, each row of the poll that links a department gets
 * audience 'departments'. Never 'all'.
 *
 * The stub keeps a poll table (draft and published rows, links as
 * department documentIds), evaluates the where shapes the guard sends, and
 * runs a transaction with Strapi's nesting rule (an inner transaction
 * joins the outer one; only the outermost commits or rolls back). Each
 * test drives the guard with a `next` that does what the Strapi 5.55.1
 * repository action does to the rows (repository.js).
 */

interface PollRow {
  id: number;
  documentId: string;
  published: boolean;
  audience: string | null;
  departments: string[];
}

type Where = Record<string, unknown>;

const inList = (cond: unknown, value: unknown): boolean =>
  ((cond as { $in?: unknown[] } | undefined)?.$in ?? []).includes(value);

const flagIsNot = (row: PollRow, value: string) => row.audience === null || row.audience !== value;

function host(initial: PollRow[] = [], options: { failUpdate?: boolean } = {}) {
  let table = initial.map((row) => ({ ...row, departments: [...row.departments] }));
  let nextId = Math.max(0, ...table.map((row) => row.id)) + 1;
  let depth = 0;
  const log = { info: vi.fn() };
  const events: string[] = [];

  const findMany = vi.fn(async ({ where }: { where: Where }) => {
    events.push(`findMany@${depth}`);
    return table
      .filter((row) => inList(where.documentId, row.documentId))
      .map((row) => ({
        id: row.id,
        audience: row.audience,
        departments: row.departments.map((documentId, index) => ({ id: index + 1, documentId })),
      }));
  });
  const updateMany = vi.fn(async ({ where, data }: { where: Where; data: { audience: string } }) => {
    events.push(`updateMany@${depth}`);
    if (options.failUpdate) throw new Error("deadlock detected");
    const hits = table.filter((row) => inList(where.id, row.id) && flagIsNot(row, "departments"));
    for (const row of hits) row.audience = data.audience;
    return { count: hits.length };
  });
  const transaction = vi.fn(async (callback: () => Promise<unknown>): Promise<unknown> => {
    const snapshot = depth === 0 ? table.map((row) => ({ ...row, departments: [...row.departments] })) : null;
    depth += 1;
    try {
      return await callback();
    } catch (error) {
      if (snapshot) table = snapshot;
      throw error;
    } finally {
      depth -= 1;
    }
  });

  const strapi: PollAudienceGuardHost = {
    db: {
      query: vi.fn(() => ({ findMany, updateMany })),
      transaction: <T>(callback: () => Promise<T>) => transaction(callback) as Promise<T>,
    },
    log,
  };

  /** Row writes as the repository does them (entries.js create/publish/discardDraft, delete). */
  const rows = {
    all: () => table,
    of: (documentId: string) => table.filter((row) => row.documentId === documentId),
    insert(row: Omit<PollRow, "id">) {
      events.push(`insert@${depth}`);
      const created = { ...row, id: nextId++, departments: [...row.departments] };
      table.push(created);
      return created;
    },
    remove(predicate: (row: PollRow) => boolean) {
      table = table.filter((row) => !predicate(row));
    },
    publish(documentId: string) {
      const draft = table.find((row) => row.documentId === documentId && !row.published);
      rows.remove((row) => row.documentId === documentId && row.published);
      return draft ? rows.insert({ ...draft, published: true }) : null;
    },
    discardDraft(documentId: string) {
      const published = table.find((row) => row.documentId === documentId && row.published);
      rows.remove((row) => row.documentId === documentId && !row.published);
      return published ? rows.insert({ ...published, published: false }) : null;
    },
  };
  return { strapi, rows, findMany, updateMany, transaction, log, events, depth: () => depth };
}

/** The row as the action returns it (repository results carry the flag). */
const asResult = (row: PollRow | null) =>
  row && { id: row.id, documentId: row.documentId, audience: row.audience, publishedAt: row.published ? "now" : null };

const context = (action: string, params: Record<string, unknown> = {}): DocumentMiddlewareContext => ({
  uid: "api::poll.poll",
  action,
  params,
});

const flags = (rows: PollRow[]) => rows.map((row) => [row.id, row.published ? "published" : "draft", row.audience]);

describe("poll audience guard: every writing action", () => {
  it("publish of a draft with departments and Audience 'all' flags the draft and the new published row", async () => {
    const { strapi, rows, log } = host([
      { id: 1, documentId: "p1", published: false, audience: "all", departments: ["d-eng"] },
    ]);
    const guard = createPollAudienceGuard(strapi);
    const result = (await guard(context("publish", { documentId: "p1" }), async () => {
      const published = rows.publish("p1");
      return { documentId: "p1", entries: [asResult(published)] };
    })) as { entries: Array<{ audience: string }> };
    expect(flags(rows.of("p1"))).toEqual([
      [1, "draft", "departments"],
      [2, "published", "departments"],
    ]);
    // The response shows the stored flag.
    expect(result.entries[0].audience).toBe("departments");
    expect(log.info).toHaveBeenCalledWith(
      "[poll-audience] poll publish: set the audience of 2 poll row(s) to 'departments' (they link a department)",
    );
  });

  it("create (admin panel draft) flags the new draft; create with status published (content API) flags both rows", async () => {
    const { strapi, rows } = host();
    const guard = createPollAudienceGuard(strapi);
    const draft = (await guard(context("create", { data: {}, status: "draft" }), async () =>
      asResult(rows.insert({ documentId: "p2", published: false, audience: "all", departments: ["d-hr"] })),
    )) as { audience: string };
    expect(draft.audience).toBe("departments");
    expect(flags(rows.of("p2"))).toEqual([[1, "draft", "departments"]]);

    // repository.js create: create the draft, then publish inside the action;
    // the result is the published row, the documentId comes only from it.
    await guard(context("create", { data: {}, status: "published" }), async () => {
      rows.insert({ documentId: "p3", published: false, audience: "all", departments: ["d-hr", "d-eng"] });
      return asResult(rows.publish("p3"));
    });
    expect(flags(rows.of("p3"))).toEqual([
      [2, "draft", "departments"],
      [3, "published", "departments"],
    ]);
  });

  it("update flags the draft, also when the save sets Audience back to 'all' with departments still selected", async () => {
    const { strapi, rows } = host([
      { id: 1, documentId: "p1", published: false, audience: "departments", departments: ["d-eng"] },
      { id: 2, documentId: "p1", published: true, audience: "departments", departments: ["d-eng"] },
    ]);
    const guard = createPollAudienceGuard(strapi);
    const result = (await guard(context("update", { documentId: "p1", data: { audience: "all" } }), async () => {
      const draft = rows.of("p1").find((row) => !row.published) as PollRow;
      draft.audience = "all";
      return asResult(draft);
    })) as { audience: string };
    expect(result.audience).toBe("departments");
    expect(flags(rows.of("p1"))).toEqual([
      [1, "draft", "departments"],
      [2, "published", "departments"],
    ]);
  });

  it("discardDraft flags the draft cloned from a linked published row", async () => {
    const { strapi, rows } = host([
      { id: 1, documentId: "p1", published: false, audience: "all", departments: [] },
      { id: 2, documentId: "p1", published: true, audience: "all", departments: ["d-eng"] },
    ]);
    const guard = createPollAudienceGuard(strapi);
    await guard(context("discardDraft", { documentId: "p1" }), async () => ({
      documentId: "p1",
      entries: [asResult(rows.discardDraft("p1"))],
    }));
    expect(flags(rows.of("p1"))).toEqual([
      [2, "published", "departments"],
      [3, "draft", "departments"],
    ]);
  });

  it("clone flags the new document (its documentId only in the result)", async () => {
    const { strapi, rows } = host([
      { id: 1, documentId: "p1", published: false, audience: "departments", departments: ["d-eng"] },
    ]);
    const guard = createPollAudienceGuard(strapi);
    await guard(context("clone", { documentId: "p1", data: { audience: "all" } }), async () => {
      const copy = rows.insert({ documentId: "p9", published: false, audience: "all", departments: ["d-eng"] });
      return { documentId: "p9", entries: [asResult(copy)] };
    });
    expect(flags(rows.of("p9"))).toEqual([[2, "draft", "departments"]]);
  });

  it("unpublish checks the draft that remains", async () => {
    const { strapi, rows } = host([
      // A draft linked by a previous cms (no flag), and its published row.
      { id: 1, documentId: "p1", published: false, audience: null, departments: ["d-eng"] },
      { id: 2, documentId: "p1", published: true, audience: null, departments: ["d-eng"] },
    ]);
    const guard = createPollAudienceGuard(strapi);
    await guard(context("unpublish", { documentId: "p1" }), async () => {
      const removed = rows.of("p1").filter((row) => row.published);
      rows.remove((row) => row.documentId === "p1" && row.published);
      return { documentId: "p1", entries: removed.map(asResult) };
    });
    expect(flags(rows.of("p1"))).toEqual([[1, "draft", "departments"]]);
  });

  it("bulk publish (the Content Manager's per-document publishes in one outer transaction) flags every poll", async () => {
    const { strapi, rows, transaction } = host([
      { id: 1, documentId: "p1", published: false, audience: "all", departments: ["d-eng"] },
      { id: 2, documentId: "p2", published: false, audience: "all", departments: [] },
      { id: 3, documentId: "p3", published: false, audience: null, departments: ["d-hr"] },
    ]);
    const guard = createPollAudienceGuard(strapi);
    const publish = (documentId: string) =>
      guard(context("publish", { documentId }), async () => ({
        documentId,
        entries: [asResult(rows.publish(documentId))],
      }));
    // document-manager.js publishMany: strapi.db.transaction(() => Promise.all(publish…)).
    await strapi.db.transaction(() => Promise.all(["p1", "p2", "p3"].map(publish)));
    expect(transaction).toHaveBeenCalledTimes(4);
    expect(flags(rows.all())).toEqual([
      [1, "draft", "departments"],
      [2, "draft", "all"],
      [3, "draft", "departments"],
      [4, "published", "departments"],
      [5, "published", "all"],
      [6, "published", "departments"],
    ]);
  });

  it("a poll linked after the department delete scanned stays restricted once the cascade removes its link", async () => {
    // Codex finding 1: the delete hook scans (no poll links d-eng yet), then
    // another transaction creates and commits a poll linked to d-eng with
    // Audience 'all', then the delete's cascade removes that link.
    const targetedAfterCascade = async (guarded: boolean) => {
      const { strapi, rows } = host();
      const create = async () =>
        asResult(rows.insert({ documentId: "late", published: false, audience: "all", departments: ["d-eng"] }));
      if (guarded) await createPollAudienceGuard(strapi)(context("create", { status: "draft" }), create);
      else await create();
      for (const row of rows.all()) row.departments = row.departments.filter((id) => id !== "d-eng");
      return rows.all().map((row) => isPollTargeted({ audience: row.audience, departments: [] }));
    };
    // Without the guard the poll turned company-wide; with it the flag
    // committed together with the link.
    await expect(targetedAfterCascade(false)).resolves.toEqual([false]);
    await expect(targetedAfterCascade(true)).resolves.toEqual([true]);
  });

  it("covers exactly the writing actions of the Strapi 5.55.1 repository", () => {
    expect([...POLL_WRITE_ACTIONS].sort()).toEqual(
      ["clone", "create", "discardDraft", "publish", "unpublish", "update"].sort(),
    );
  });
});

describe("poll audience guard: never widens, stays in its lane", () => {
  it("never sets 'all' and never touches a row without links", async () => {
    const { strapi, rows, updateMany, log } = host([
      // Flag-only restricted (its departments were deleted): stays restricted.
      { id: 1, documentId: "p1", published: false, audience: "departments", departments: [] },
      // Company-wide: stays company-wide.
      { id: 2, documentId: "p1", published: true, audience: "all", departments: [] },
      { id: 3, documentId: "p1", published: true, audience: null, departments: [] },
    ]);
    const guard = createPollAudienceGuard(strapi);
    await guard(context("update", { documentId: "p1" }), async () => asResult(rows.of("p1")[0]));
    expect(flags(rows.all())).toEqual([
      [1, "draft", "departments"],
      [2, "published", "all"],
      [3, "published", null],
    ]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("updates only rows that are not flagged yet, with a where that never widens", async () => {
    const { strapi, rows, updateMany } = host([
      { id: 1, documentId: "p1", published: false, audience: "departments", departments: ["d-eng"] },
      { id: 2, documentId: "p1", published: true, audience: "all", departments: ["d-eng"] },
    ]);
    const guard = createPollAudienceGuard(strapi);
    await guard(context("publish", { documentId: "p1" }), async () => ({ documentId: "p1", entries: [] }));
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        id: { $in: [2] },
        $or: [{ audience: { $null: true } }, { audience: { $ne: "departments" } }],
      },
      data: { audience: "departments" },
    });
    expect(flags(rows.all())).toEqual([
      [1, "draft", "departments"],
      [2, "published", "departments"],
    ]);
  });

  it("reads the rows with their links, id in every select", async () => {
    const { strapi, findMany } = host();
    const guard = createPollAudienceGuard(strapi);
    await guard(context("update", { documentId: "p1" }), async () => null);
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where: { documentId: { $in: ["p1"] } },
      select: ["id", "audience"],
      populate: { departments: { select: ["id", "documentId"] } },
    });
  });

  it("passes reads, deletes and other content types through, without a transaction", async () => {
    const { strapi, transaction, findMany } = host();
    const guard = createPollAudienceGuard(strapi);
    const cases: DocumentMiddlewareContext[] = [
      context("findMany"),
      context("findOne", { documentId: "p1" }),
      context("findFirst"),
      context("count"),
      context("delete", { documentId: "p1" }),
      { uid: "api::announcement.announcement", action: "publish", params: { documentId: "a1" } },
    ];
    for (const ctx of cases) {
      const next = vi.fn(async () => "result");
      await expect(guard(ctx, next), `${ctx.uid} ${ctx.action}`).resolves.toBe("result");
      expect(next).toHaveBeenCalledOnce();
    }
    expect(transaction).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("poll audience guard: one transaction with the action", () => {
  it("runs the action and the flag inside the transaction it opens", async () => {
    const { strapi, rows, events } = host();
    const guard = createPollAudienceGuard(strapi);
    await guard(context("create", { status: "draft" }), async () =>
      asResult(rows.insert({ documentId: "p1", published: false, audience: "all", departments: ["d-eng"] })),
    );
    expect(events).toEqual(["insert@1", "findMany@1", "updateMany@1"]);
  });

  it("a failing flag step rolls the action back and fails it", async () => {
    const { strapi, rows } = host([], { failUpdate: true });
    const guard = createPollAudienceGuard(strapi);
    await expect(
      guard(context("create", { status: "draft" }), async () =>
        asResult(rows.insert({ documentId: "p1", published: false, audience: "all", departments: ["d-eng"] })),
      ),
    ).rejects.toThrow("deadlock detected");
    expect(rows.all()).toEqual([]);
  });

  it("a failing action is not flagged and rolls back", async () => {
    const { strapi, rows, findMany } = host();
    const guard = createPollAudienceGuard(strapi);
    await expect(
      guard(context("create", { status: "draft" }), async () => {
        rows.insert({ documentId: "p1", published: false, audience: "all", departments: ["d-eng"] });
        throw new Error("ValidationError");
      }),
    ).rejects.toThrow("ValidationError");
    expect(findMany).not.toHaveBeenCalled();
    expect(rows.all()).toEqual([]);
  });
});

describe("affectedDocumentIds and bounds", () => {
  it("collects the documentId of the params, the result row and the result entries, once each", () => {
    expect(affectedDocumentIds({ documentId: "src" }, { documentId: "new", entries: [{ documentId: "new" }] })).toEqual([
      "src",
      "new",
    ]);
    expect(affectedDocumentIds({}, { id: 3, documentId: "p3" })).toEqual(["p3"]);
    expect(affectedDocumentIds(undefined, null)).toEqual([]);
    expect(affectedDocumentIds({ documentId: "" }, { entries: [null, { documentId: 7 }] })).toEqual([]);
  });

  it("does nothing without a documentId", async () => {
    const { strapi, findMany } = host();
    const guard = createPollAudienceGuard(strapi);
    await guard(context("update", {}), async () => null);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("reads and updates in bounded chunks", async () => {
    const many: PollRow[] = Array.from({ length: POLL_AUDIENCE_GUARD_CHUNK + 1 }, (_, i) => ({
      id: i + 1,
      documentId: `p${i + 1}`,
      published: false,
      audience: "all",
      departments: ["d-eng"],
    }));
    const { strapi, findMany, updateMany } = host(many);
    const guard = createPollAudienceGuard(strapi);
    await guard(context("publish", {}), async () => ({
      documentId: undefined,
      entries: many.map((row) => ({ documentId: row.documentId })),
    }));
    const sizes = (calls: Array<[{ where: Where }]>, key: string) =>
      calls.map(([params]) => ((params.where[key] as { $in: unknown[] }).$in ?? []).length);
    expect(sizes(findMany.mock.calls as Array<[{ where: Where }]>, "documentId")).toEqual([POLL_AUDIENCE_GUARD_CHUNK, 1]);
    expect(sizes(updateMany.mock.calls as Array<[{ where: Where }]>, "id")).toEqual([POLL_AUDIENCE_GUARD_CHUNK, 1]);
  });
});

describe("registerPollAudienceGuard", () => {
  it("hangs one middleware onto strapi.documents", () => {
    const { strapi } = host();
    const use = vi.fn();
    registerPollAudienceGuard({ ...strapi, documents: { use } });
    expect(use).toHaveBeenCalledOnce();
    expect(typeof use.mock.calls[0]?.[0]).toBe("function");
  });

  it("refuses to boot when strapi.documents.use is gone", () => {
    const { strapi } = host();
    expect(() => registerPollAudienceGuard({ ...strapi, documents: {} })).toThrow(
      /^\[poll-audience\] strapi\.documents\.use not found/,
    );
    expect(() => registerPollAudienceGuard({ ...strapi, documents: null })).toThrow(/refusing to boot/);
  });
});
