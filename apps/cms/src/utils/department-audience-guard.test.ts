import { describe, expect, it, vi } from "vitest";
import {
  createDepartmentAudienceGuard,
  DEPARTMENT_AUDIENCE_LOG,
  registerDepartmentAudienceGuard,
} from "./department-audience-guard";
import { DEPARTMENTS_AUDIENCE } from "./policy-factories";
import type { DocumentMiddlewareContext, PollAudienceGuardHost } from "./poll-audience-guard";

/**
 * Write-time audience guard for documents and quick links (FX29 residual,
 * batch 12 review B12-01): after every Document Service write of either
 * type, in the same transaction, each row of the document that links a
 * department gets audience 'departments'. Never 'all'. The middleware is
 * the poll guard's (poll-audience-guard.test.ts pins its mechanics: the
 * transaction, the chunks, the result patch); this suite pins what the
 * document and quick-link instance covers and the cases B12-01 is about:
 * a copy of a row taken before a department delete (a publish, a
 * "Discard changes", an open admin form) carries the flag.
 *
 * The stub keeps one table per type (draft and published rows, links as
 * department documentIds) and a transaction with Strapi's nesting rule;
 * `next` does what the Strapi 5.55.1 repository action does to the rows.
 */

const TYPES = [
  { uid: "api::document.document", label: "document" },
  { uid: "api::quick-link.quick-link", label: "quick-link" },
] as const;

interface Row {
  id: number;
  documentId: string;
  published: boolean;
  audience: string | null;
  departments: string[];
}

type Where = Record<string, unknown>;

const inList = (cond: unknown, value: unknown): boolean =>
  ((cond as { $in?: unknown[] } | undefined)?.$in ?? []).includes(value);

/** departmentScopedIds' rule (policy-factories.ts): company-wide for everyone. */
const companyWide = (row: Row) =>
  row.departments.length === 0 && row.audience !== DEPARTMENTS_AUDIENCE;

function host(uid: string, initial: Row[] = []) {
  let table = initial.map((row) => ({ ...row, departments: [...row.departments] }));
  let nextId = Math.max(0, ...table.map((row) => row.id)) + 1;
  const log = { info: vi.fn() };
  const queried: string[] = [];

  const findMany = vi.fn(async ({ where }: { where: Where }) =>
    table
      .filter((row) => inList(where.documentId, row.documentId))
      .map((row) => ({
        id: row.id,
        audience: row.audience,
        departments: row.departments.map((documentId, index) => ({ id: index + 1, documentId })),
      })),
  );
  const updateMany = vi.fn(
    async ({ where, data }: { where: Where; data: { audience: string } }) => {
      const hits = table.filter(
        (row) => inList(where.id, row.id) && row.audience !== DEPARTMENTS_AUDIENCE,
      );
      for (const row of hits) row.audience = data.audience;
      return { count: hits.length };
    },
  );
  const transaction = vi.fn(async (callback: () => Promise<unknown>) => callback());
  const strapi: PollAudienceGuardHost = {
    db: {
      query: vi.fn((queriedUid: string) => {
        queried.push(queriedUid);
        return { findMany, updateMany };
      }),
      transaction: <T>(callback: () => Promise<T>) => transaction(callback) as Promise<T>,
    },
    log,
  };

  const rows = {
    all: () => table,
    of: (documentId: string) => table.filter((row) => row.documentId === documentId),
    insert(row: Omit<Row, "id">) {
      const created = { ...row, id: nextId++, departments: [...row.departments] };
      table.push(created);
      return created;
    },
    remove(predicate: (row: Row) => boolean) {
      table = table.filter((row) => !predicate(row));
    },
    /** A copy of a row, as a repository read hands it on. */
    copy: (row: Row): Row => ({ ...row, departments: [...row.departments] }),
    /** A department delete: the hook flags the linked rows, the cascade removes the links. */
    deleteDepartment(department: string) {
      for (const row of table) {
        if (row.departments.includes(department)) {
          row.audience = DEPARTMENTS_AUDIENCE;
          row.departments = row.departments.filter((id) => id !== department);
        }
      }
    },
    /**
     * entries.js publishEntry/discardDraftEntry: the old twin goes, a new
     * one is created from `source` (a copy read earlier), and a department
     * that no longer exists is dropped (allowMissingId).
     */
    recreate(source: Row, published: boolean, existing: ReadonlySet<string>) {
      rows.remove((row) => row.documentId === source.documentId && row.published === published);
      return rows.insert({
        ...source,
        published,
        departments: source.departments.filter((id) => existing.has(id)),
      });
    },
  };
  return { strapi, rows, findMany, updateMany, transaction, log, queried };
}

const context = (
  uid: string,
  action: string,
  params: Record<string, unknown> = {},
): DocumentMiddlewareContext => ({ uid, action, params });

const asResult = (row: Row | null) =>
  row && { id: row.id, documentId: row.documentId, audience: row.audience };

const flags = (rows: Row[]) =>
  rows.map((row) => [row.published ? "published" : "draft", row.audience, row.departments]);

describe.each(TYPES)("department audience guard: $label", ({ uid, label }) => {
  it("create flags both rows of a document published with a department and Audience 'all'", async () => {
    const { strapi, rows, log, queried } = host(uid);
    const guard = createDepartmentAudienceGuard(strapi);
    const result = (await guard(context(uid, "create", { status: "published" }), async () => {
      const draft = rows.insert({
        documentId: "d1",
        published: false,
        audience: "all",
        departments: ["d-eng"],
      });
      return asResult(rows.recreate(rows.copy(draft), true, new Set(["d-eng"])));
    })) as { audience: string };
    expect(flags(rows.of("d1"))).toEqual([
      ["draft", "departments", ["d-eng"]],
      ["published", "departments", ["d-eng"]],
    ]);
    expect(result.audience).toBe("departments");
    expect(queried).toEqual([uid]);
    expect(log.info).toHaveBeenCalledExactlyOnceWith(
      `[department-audience] ${label} create: set the audience of 2 ${label} row(s) to 'departments' (they link a department)`,
    );
  });

  it("a publish that read the draft before a department delete keeps the recreated row restricted", async () => {
    // B12-01 (Codex): publish reads the draft, the delete flags and unlinks
    // and commits, the publish recreates the published row from its copy.
    const published = async (guarded: boolean) => {
      const { strapi, rows } = host(uid);
      const guard = createDepartmentAudienceGuard(strapi);
      const write = <T>(action: string, params: Record<string, unknown>, next: () => Promise<T>) =>
        guarded ? guard(context(uid, action, params), next) : next();
      await write("create", { status: "published" }, async () => {
        const draft = rows.insert({
          documentId: "d1",
          published: false,
          audience: "all",
          departments: ["d-it"],
        });
        return asResult(rows.recreate(rows.copy(draft), true, new Set(["d-it"])));
      });
      await write("publish", { documentId: "d1" }, async () => {
        const staleDraft = rows.copy(rows.of("d1").find((row) => !row.published) as Row);
        rows.deleteDepartment("d-it");
        const entry = rows.recreate(staleDraft, true, new Set());
        return { documentId: "d1", entries: [asResult(entry)] };
      });
      return rows.of("d1").find((row) => row.published) as Row;
    };
    // Without the guard the copy said 'all', and the department was dropped.
    expect(companyWide(await published(false))).toBe(true);
    const row = await published(true);
    expect([row.audience, row.departments]).toEqual(["departments", []]);
    expect(companyWide(row)).toBe(false);
  });

  it("'Discard changes' that read the published row before a department delete keeps the new draft restricted", async () => {
    const { strapi, rows } = host(uid);
    const guard = createDepartmentAudienceGuard(strapi);
    await guard(context(uid, "create", { status: "published" }), async () => {
      const draft = rows.insert({
        documentId: "d1",
        published: false,
        audience: "all",
        departments: ["d-it"],
      });
      return asResult(rows.recreate(rows.copy(draft), true, new Set(["d-it"])));
    });
    await guard(context(uid, "discardDraft", { documentId: "d1" }), async () => {
      const stalePublished = rows.copy(rows.of("d1").find((row) => row.published) as Row);
      rows.deleteDepartment("d-it");
      return {
        documentId: "d1",
        entries: [asResult(rows.recreate(stalePublished, false, new Set()))],
      };
    });
    expect(flags(rows.of("d1"))).toEqual([
      ["published", "departments", []],
      ["draft", "departments", []],
    ]);
  });

  it("an admin form opened before a department delete saves and publishes the row restricted", async () => {
    // B12-01 (b): the form holds every field as loaded, Audience included;
    // with the guard it loaded 'departments'.
    const { strapi, rows } = host(uid);
    const guard = createDepartmentAudienceGuard(strapi);
    const created = (await guard(context(uid, "create", { status: "draft" }), async () =>
      asResult(
        rows.insert({ documentId: "d1", published: false, audience: "all", departments: ["d-it"] }),
      ),
    )) as { audience: string };
    const form = { audience: created.audience };
    rows.deleteDepartment("d-it");
    await guard(context(uid, "update", { documentId: "d1", data: form }), async () => {
      const draft = rows.of("d1")[0];
      draft.audience = form.audience;
      return asResult(draft);
    });
    await guard(context(uid, "publish", { documentId: "d1" }), async () => {
      const draft = rows.copy(rows.of("d1")[0]);
      return { documentId: "d1", entries: [asResult(rows.recreate(draft, true, new Set()))] };
    });
    expect(form.audience).toBe("departments");
    expect(rows.all().map(companyWide)).toEqual([false, false]);
  });

  it("never widens: removing every department keeps the flag until Audience is set to 'all'", async () => {
    const { strapi, rows, updateMany } = host(uid, [
      { id: 1, documentId: "d1", published: false, audience: "departments", departments: ["d-it"] },
      { id: 2, documentId: "d2", published: false, audience: "all", departments: [] },
      { id: 3, documentId: "d3", published: false, audience: null, departments: [] },
    ]);
    const guard = createDepartmentAudienceGuard(strapi);
    const update = (documentId: string, change: (row: Row) => void) =>
      guard(context(uid, "update", { documentId }), async () => {
        const row = rows.of(documentId)[0];
        change(row);
        return asResult(row);
      });
    await update("d1", (row) => {
      row.departments = [];
    });
    expect(rows.of("d1")[0].audience).toBe("departments");
    await update("d1", (row) => {
      row.audience = "all";
    });
    expect(companyWide(rows.of("d1")[0])).toBe(true);
    // Rows without links are never written.
    await update("d2", () => undefined);
    await update("d3", () => undefined);
    expect(flags(rows.all())).toEqual([
      ["draft", "all", []],
      ["draft", "all", []],
      ["draft", null, []],
    ]);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("Audience 'all' saved while a department remains is flipped back to 'departments'", async () => {
    const { strapi, rows } = host(uid, [
      { id: 1, documentId: "d1", published: false, audience: "departments", departments: ["d-it"] },
    ]);
    const guard = createDepartmentAudienceGuard(strapi);
    const result = (await guard(
      context(uid, "update", { documentId: "d1", data: { audience: "all" } }),
      async () => {
        rows.of("d1")[0].audience = "all";
        return asResult(rows.of("d1")[0]);
      },
    )) as { audience: string };
    expect(result.audience).toBe("departments");
    expect(rows.of("d1")[0].audience).toBe("departments");
  });
});

describe("department audience guard: stays in its lane", () => {
  it("passes polls, other types, reads and deletes through without a transaction", async () => {
    const { strapi, transaction, findMany } = host("api::document.document");
    const guard = createDepartmentAudienceGuard(strapi);
    const cases: DocumentMiddlewareContext[] = [
      context("api::poll.poll", "publish", { documentId: "p1" }),
      context("api::announcement.announcement", "update", { documentId: "a1" }),
      context("api::document.document", "findMany"),
      context("api::quick-link.quick-link", "findOne", { documentId: "q1" }),
      context("api::document.document", "delete", { documentId: "d1" }),
    ];
    for (const ctx of cases) {
      const next = vi.fn(async () => "result");
      await expect(guard(ctx, next), `${ctx.uid} ${ctx.action}`).resolves.toBe("result");
      expect(next).toHaveBeenCalledOnce();
    }
    expect(transaction).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("guards every writing action of both types in a transaction", async () => {
    for (const { uid } of TYPES) {
      for (const action of ["create", "update", "clone", "publish", "unpublish", "discardDraft"]) {
        const { strapi, transaction } = host(uid);
        const guard = createDepartmentAudienceGuard(strapi);
        await guard(context(uid, action, { documentId: "d1" }), async () => null);
        expect(transaction, `${uid} ${action}`).toHaveBeenCalledOnce();
      }
    }
  });
});

describe("registerDepartmentAudienceGuard", () => {
  it("hangs one middleware onto strapi.documents", () => {
    const { strapi } = host("api::document.document");
    const use = vi.fn();
    registerDepartmentAudienceGuard({ ...strapi, documents: { use } });
    expect(use).toHaveBeenCalledOnce();
    expect(typeof use.mock.calls[0]?.[0]).toBe("function");
  });

  it("refuses to boot when strapi.documents.use is gone", () => {
    const { strapi } = host("api::document.document");
    expect(DEPARTMENT_AUDIENCE_LOG).toBe("[department-audience]");
    expect(() => registerDepartmentAudienceGuard({ ...strapi, documents: {} })).toThrow(
      /^\[department-audience\] strapi\.documents\.use not found/,
    );
    expect(() => registerDepartmentAudienceGuard({ ...strapi, documents: null })).toThrow(
      /refusing to boot/,
    );
  });
});
