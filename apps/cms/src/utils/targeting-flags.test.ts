import { afterEach, describe, expect, it, vi } from "vitest";

import { createStrapiStub, type StrapiStub } from "../test/strapi-stub.test.helper";
import { createDepartmentAudienceGuard } from "./department-audience-guard";
import type { DocumentMiddlewareContext, PollAudienceGuardHost } from "./poll-audience-guard";
import {
  ANNOUNCEMENT,
  DEPARTMENT,
  DOCUMENT,
  EVENT,
  TEAM,
  WIKI_PAGE,
  deleteHost,
  DUTY_PLAN,
  KPI,
} from "./targeting-flags.test.helper";
import {
  ANNOUNCEMENT_TARGETING,
  DEPARTMENT_LINKED_DOCUMENTS,
  EVENT_TARGETING,
  TARGETING_FLAGS_PAGE,
  TARGETING_FLAG_TYPES,
  TEAM_LINKED_DOCUMENTS,
  advanceRevisionsOf,
  compareDocumentRefs,
  createTargetingFlagsGuard,
  documentsLinking,
  flagEventsLinking,
  lockMatchedRows,
  markAnnouncementsLinking,
  raiseTargetingFlags,
  relationLinkTable,
  type TargetingDeleteHost,
} from "./targeting-flags";

/**
 * The announcement and event targeting flags (batch 15 lane 15D; decision
 * 06 §K 3, §N9): the write-time guard raises them on every linked row in
 * the transaction of each Document Service write, never lowers them, and
 * patches the result; the delete-hook helpers find the linked rows through
 * the link tables, raise the flags and the marker, and lock and advance
 * the revisions in ascending order. The lifecycles' own suites drive the
 * whole department and team deletes.
 *
 * The shared stub honours select, populate and the where operators, so a
 * flag the guard did not select or a where that would widen fails here.
 */

const revisions = vi.hoisted(() => ({ log: [] as string[] }));
vi.mock("./document-lock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./document-lock")>()),
  lockDocument: vi.fn(async (_strapi: unknown, uid: string, documentId: string) => {
    revisions.log.push(`lock ${uid} ${documentId}`);
    return 0;
  }),
  advanceRevision: vi.fn(async (_strapi: unknown, uid: string, documentId: string) => {
    revisions.log.push(`advance ${uid} ${documentId}`);
    return 1;
  }),
}));

afterEach(() => {
  revisions.log.length = 0;
});

const ENG = 10;
const SALES = 11;
const PLATFORM = 30;

const context = (
  uid: string,
  action: string,
  params: Record<string, unknown> = {},
): DocumentMiddlewareContext => ({ uid, action, params });

/** The stub with an organisation, as the guard sees it. */
function guardHost() {
  const strapi = createStrapiStub({
    tables: {
      [DEPARTMENT]: [
        { id: ENG, name: "Engineering", documentId: "dep-eng", publishedAt: "2026-01-01" },
        { id: SALES, name: "Sales", documentId: "dep-sales", publishedAt: "2026-01-01" },
      ],
      [TEAM]: [{ id: PLATFORM, name: "Platform", documentId: "team-platform" }],
    },
  });
  const transaction = vi.spyOn(strapi.db, "transaction");
  return {
    strapi,
    transaction,
    guard: createDepartmentAudienceGuard(strapi as unknown as PollAudienceGuardHost),
  };
}

const rowsOf = (strapi: StrapiStub, uid: string, documentId: string, key: string) =>
  strapi.tables[uid]
    .filter((row) => row.documentId === documentId)
    .map((row) => [row.publishedAt ? "published" : "draft", row[key] ?? null]);

describe("targeting guard: announcements", () => {
  it("create with status published flags both rows linking a department, and the result", async () => {
    const { strapi, guard } = guardHost();
    const result = (await guard(context(ANNOUNCEMENT, "create", { status: "published" }), () =>
      strapi.documents(ANNOUNCEMENT).create({
        data: { title: "Eng", audience: "all", department: { id: ENG } },
        status: "published",
      }),
    )) as { documentId: string; audience: string };
    expect(rowsOf(strapi, ANNOUNCEMENT, result.documentId, "audience")).toEqual([
      ["draft", "departments"],
      ["published", "departments"],
    ]);
    expect(result.audience).toBe("departments");
    expect(strapi.log.info).toHaveBeenCalledExactlyOnceWith(
      "[targeting-flags] announcement create: set the audience of 2 announcement row(s) to " +
        "'departments' (they link a target)",
    );
  });

  it("a team alone raises the flag too", async () => {
    const { strapi, guard } = guardHost();
    const result = (await guard(context(ANNOUNCEMENT, "create"), () =>
      strapi.documents(ANNOUNCEMENT).create({ data: { title: "Team", team: { id: PLATFORM } } }),
    )) as { documentId: string };
    expect(rowsOf(strapi, ANNOUNCEMENT, result.documentId, "audience")).toEqual([
      ["draft", "departments"],
    ]);
  });

  it("an update setting Audience 'all' while a target remains is flipped back", async () => {
    const { strapi, guard } = guardHost();
    const { documentId } = strapi.seedDocument(ANNOUNCEMENT, {
      title: "Eng",
      audience: "departments",
      department: { id: ENG },
    });
    const result = (await guard(
      context(ANNOUNCEMENT, "update", { documentId, data: { audience: "all" } }),
      () => strapi.documents(ANNOUNCEMENT).update({ documentId, data: { audience: "all" } }),
    )) as { audience: string };
    expect(result.audience).toBe("departments");
    expect(rowsOf(strapi, ANNOUNCEMENT, documentId, "audience")).toEqual([
      ["draft", "departments"],
    ]);
  });

  it("never lowers and never touches a row without targets", async () => {
    const { strapi, guard } = guardHost();
    const restricted = strapi.seedDocument(ANNOUNCEMENT, { title: "R", audience: "departments" });
    const open = strapi.seedDocument(ANNOUNCEMENT, { title: "O", audience: "all" });
    const legacy = strapi.seedDocument(ANNOUNCEMENT, { title: "L", audience: null });
    const updateMany = vi.fn();
    const query = strapi.db.query.bind(strapi.db);
    strapi.db.query = (uid: string) => ({ ...query(uid), updateMany });
    for (const { documentId } of [restricted, open, legacy]) {
      await guard(context(ANNOUNCEMENT, "update", { documentId }), () =>
        strapi.documents(ANNOUNCEMENT).update({ documentId, data: { title: "x" } }),
      );
    }
    expect(updateMany).not.toHaveBeenCalled();
    expect(
      [restricted, open, legacy].map(
        ({ documentId }) => rowsOf(strapi, ANNOUNCEMENT, documentId, "audience")[0][1],
      ),
    ).toEqual(["departments", "all", null]);
  });

  it("a publish that copies a stale draft keeps the new published row restricted", async () => {
    // The draft linked Engineering with Audience 'all' (written before the
    // guard); the publish copies it, Strapi drops the department deleted in
    // between, and the new published row would be company-wide.
    const { strapi, guard } = guardHost();
    const { documentId } = strapi.seedDocument(ANNOUNCEMENT, {
      title: "Stale",
      audience: "all",
      department: { id: ENG },
    });
    await guard(context(ANNOUNCEMENT, "publish", { documentId }), async () => {
      const published = await strapi.documents(ANNOUNCEMENT).publish({ documentId });
      return published;
    });
    expect(rowsOf(strapi, ANNOUNCEMENT, documentId, "audience")).toEqual([
      ["draft", "departments"],
      ["published", "departments"],
    ]);
  });
});

describe("targeting guard: events", () => {
  it("flags notifyAudience on both rows that link a department, and the entries of the result", async () => {
    const { strapi, guard } = guardHost();
    const { documentId } = strapi.seedDocument(EVENT, {
      title: "Party",
      start: "2026-10-01T16:00:00.000Z",
      notifyAudience: "all",
      departments: [{ id: ENG }, { id: SALES }],
    });
    const result = (await guard(context(EVENT, "publish", { documentId }), () =>
      strapi.documents(EVENT).publish({ documentId }),
    )) as { entries: { notifyAudience: string }[] };
    expect(rowsOf(strapi, EVENT, documentId, "notifyAudience")).toEqual([
      ["draft", "departments"],
      ["published", "departments"],
    ]);
    expect(result.entries.map((entry) => entry.notifyAudience)).toEqual(["departments"]);
    expect(strapi.log.info).toHaveBeenCalledWith(
      "[targeting-flags] event publish: set the notifyAudience of 2 event row(s) to " +
        "'departments' (they link a target)",
    );
  });

  it("leaves an event without departments alone (NULL reads as 'all')", async () => {
    const { strapi, guard } = guardHost();
    const { documentId } = strapi.seedDocument(EVENT, {
      title: "Everyone",
      start: "2026-10-01T16:00:00.000Z",
      notifyAudience: null,
      departments: [],
    });
    await guard(context(EVENT, "publish", { documentId }), () =>
      strapi.documents(EVENT).publish({ documentId }),
    );
    expect(rowsOf(strapi, EVENT, documentId, "notifyAudience")).toEqual([
      ["draft", null],
      ["published", null],
    ]);
  });

  it("keeps 'departments' when the last department is removed (notifies nobody until re-targeted)", async () => {
    const { strapi, guard } = guardHost();
    const { documentId } = strapi.seedDocument(EVENT, {
      title: "Was Eng",
      start: "2026-10-01T16:00:00.000Z",
      notifyAudience: "departments",
      departments: [{ id: ENG }],
    });
    await guard(context(EVENT, "update", { documentId }), () =>
      strapi.documents(EVENT).update({ documentId, data: { departments: [] } }),
    );
    expect(rowsOf(strapi, EVENT, documentId, "notifyAudience")).toEqual([["draft", "departments"]]);
  });
});

describe("targeting guard: scope and transaction", () => {
  it("covers announcements and events with their flags and links", () => {
    expect(TARGETING_FLAG_TYPES).toEqual([ANNOUNCEMENT_TARGETING, EVENT_TARGETING]);
    expect(ANNOUNCEMENT_TARGETING).toMatchObject({
      flag: "audience",
      links: ["department", "team"],
    });
    expect(EVENT_TARGETING).toMatchObject({ flag: "notifyAudience", links: ["departments"] });
  });

  it("runs every writing action of both types in one transaction with the flag", async () => {
    for (const uid of [ANNOUNCEMENT, EVENT]) {
      for (const action of ["create", "update", "clone", "publish", "unpublish", "discardDraft"]) {
        const { guard, transaction } = guardHost();
        const next = vi.fn(async () => null);
        await guard(context(uid, action, { documentId: "d1" }), next);
        expect(transaction, `${uid} ${action}`).toHaveBeenCalledOnce();
        expect(next).toHaveBeenCalledOnce();
      }
    }
  });

  it("passes reads, deletes and other types through without a transaction", async () => {
    const { guard, transaction } = guardHost();
    for (const ctx of [
      context(ANNOUNCEMENT, "findMany"),
      context(EVENT, "findOne", { documentId: "e1" }),
      context(ANNOUNCEMENT, "delete", { documentId: "a1" }),
      context("api::lesson.lesson", "publish", { documentId: "l1" }),
    ]) {
      const next = vi.fn(async () => "result");
      await expect(guard(ctx, next), `${ctx.uid} ${ctx.action}`).resolves.toBe("result");
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it("a failing flag write fails the action (rolled back with it)", async () => {
    const { strapi } = guardHost();
    const query = strapi.db.query.bind(strapi.db);
    strapi.db.query = (uid: string) => ({
      ...query(uid),
      updateMany: async () => {
        throw new Error("disk full");
      },
    });
    const guard = createTargetingFlagsGuard(strapi as unknown as PollAudienceGuardHost);
    await expect(
      guard(context(ANNOUNCEMENT, "create"), () =>
        strapi.documents(ANNOUNCEMENT).create({ data: { title: "x", department: { id: ENG } } }),
      ),
    ).rejects.toThrow("disk full");
  });
});

describe("raiseTargetingFlags", () => {
  it("raises only, in bounded chunks, with a where that matches unraised rows only", async () => {
    const updateMany = vi.fn(async (_params: Record<string, unknown>) => ({ count: 1 }));
    const ids = Array.from({ length: TARGETING_FLAGS_PAGE + 1 }, (_, i) => i + 1);
    expect(await raiseTargetingFlags({ updateMany }, "notifyAudience", ids)).toBe(2);
    expect(updateMany.mock.calls.map(([params]) => params)).toEqual([
      {
        where: {
          id: { $in: ids.slice(0, TARGETING_FLAGS_PAGE) },
          $or: [{ notifyAudience: { $null: true } }, { notifyAudience: { $ne: "departments" } }],
        },
        data: { notifyAudience: "departments" },
      },
      {
        where: {
          id: { $in: [TARGETING_FLAGS_PAGE + 1] },
          $or: [{ notifyAudience: { $null: true } }, { notifyAudience: { $ne: "departments" } }],
        },
        data: { notifyAudience: "departments" },
      },
    ]);
  });

  it("with the marker sets both raised values on rows missing either", async () => {
    const updateMany = vi.fn(async (_params: Record<string, unknown>) => ({ count: 3 }));
    await raiseTargetingFlags({ updateMany }, "audience", [4], { marker: true });
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        id: { $in: [4] },
        $or: [
          { audience: { $null: true } },
          { audience: { $ne: "departments" } },
          { retargetRequired: { $null: true } },
          { retargetRequired: { $ne: true } },
        ],
      },
      data: { audience: "departments", retargetRequired: true },
    });
  });
});

describe("delete-hook helpers", () => {
  /** Engineering and Sales; the Platform team; an announcement, event and document each. */
  function org() {
    return {
      [DEPARTMENT]: [
        { id: ENG, documentId: "dep-eng" },
        { id: SALES, documentId: "dep-sales" },
      ],
      [TEAM]: [{ id: PLATFORM, documentId: "team-platform" }],
      [ANNOUNCEMENT]: [
        // Engineering plus Platform, both rows.
        {
          id: 1,
          documentId: "ann-b",
          audience: "departments",
          department: { id: ENG },
          team: { id: PLATFORM },
          publishedAt: null,
        },
        {
          id: 2,
          documentId: "ann-b",
          audience: "departments",
          department: { id: ENG },
          team: { id: PLATFORM },
          publishedAt: "2026-01-01",
        },
        // Sales, owned by Engineering.
        {
          id: 3,
          documentId: "ann-a",
          audience: "departments",
          department: { id: SALES },
          ownerDepartment: { id: ENG },
          publishedAt: null,
        },
        // Platform only, a legacy row with Audience 'all' and no marker yet.
        {
          id: 4,
          documentId: "ann-c",
          audience: "all",
          team: { id: PLATFORM },
          retargetRequired: false,
          publishedAt: null,
        },
        // Company-wide.
        { id: 5, documentId: "ann-z", audience: "all", publishedAt: null },
      ],
      [EVENT]: [
        {
          id: 1,
          documentId: "ev-b",
          notifyAudience: null,
          departments: [{ id: ENG }, { id: SALES }],
          publishedAt: null,
        },
        {
          id: 2,
          documentId: "ev-a",
          notifyAudience: "all",
          departments: [{ id: SALES }],
          ownerDepartment: { id: ENG },
          publishedAt: null,
        },
        {
          id: 3,
          documentId: "ev-c",
          notifyAudience: "all",
          departments: [{ id: ENG }],
          publishedAt: "2026-01-01",
        },
      ],
      [DOCUMENT]: [
        {
          id: 1,
          documentId: "doc-a",
          audience: "departments",
          departments: [{ id: ENG }],
          publishedAt: null,
        },
        { id: 2, documentId: "doc-b", audience: "all", departments: [], publishedAt: null },
      ],
      // Duty plans (v0.18): the department decides the head's and the lead's class.
      [DUTY_PLAN]: [
        {
          id: 1,
          documentId: "duty-a",
          department: { id: ENG },
          ownerDepartment: { id: ENG },
          publishedAt: null,
        },
      ],
      // KPIs (v0.19): the department decides the head's class.
      [KPI]: [
        {
          id: 1,
          documentId: "kpi-a",
          department: { id: ENG },
          ownerDepartment: { id: ENG },
          publishedAt: null,
        },
      ],
      // Wiki pages (batch 16): the department decides the head's class, the team the lead's.
      [WIKI_PAGE]: [
        { id: 1, documentId: "wiki-a", department: { id: ENG }, publishedAt: null },
        { id: 2, documentId: "wiki-a", department: { id: ENG }, publishedAt: "2026-01-01" },
        { id: 3, documentId: "wiki-b", team: { id: PLATFORM }, publishedAt: null },
        { id: 4, documentId: "wiki-c", department: { id: SALES }, publishedAt: null },
      ],
    };
  }

  const asHost = (strapi: unknown) => strapi as TargetingDeleteHost;

  it("relationLinkTable reads the join table from the metadata, or refuses", () => {
    const { strapi } = deleteHost(org());
    expect(relationLinkTable(strapi, ANNOUNCEMENT, "team", "refused")).toEqual({
      uid: "announcements_team_lnk",
      rowColumn: "announcement_id",
      targetColumn: "team_id",
    });
    expect(() => relationLinkTable(strapi, ANNOUNCEMENT, "nope", "refusing X")).toThrow(
      "[targeting-flags] the link table of api::announcement.announcement.nope is unknown; refusing X",
    );
  });

  it("lockMatchedRows pages the delete's rows and locks them on Postgres only", async () => {
    for (const dialect of ["postgres", "sqlite"]) {
      const { strapi, events } = deleteHost(org(), { dialect });
      expect(await lockMatchedRows(asHost(strapi), DEPARTMENT, { id: ENG })).toEqual([ENG]);
      expect(await lockMatchedRows(asHost(strapi), DEPARTMENT, null)).toEqual([ENG, SALES]);
      expect(
        events.filter((event) => event.startsWith("lock-rows")),
        dialect,
      ).toEqual(
        dialect === "postgres"
          ? [`lock-rows ${DEPARTMENT} [${ENG}]`, `lock-rows ${DEPARTMENT} [${ENG},${SALES}]`]
          : [],
      );
    }
  });

  it("documentsLinking finds every document linking a deleted department, once, ascending", async () => {
    const { strapi } = deleteHost(org());
    const refs = await documentsLinking(asHost(strapi), DEPARTMENT_LINKED_DOCUMENTS, [ENG], "x");
    expect(refs).toEqual([
      { uid: ANNOUNCEMENT, documentId: "ann-a" },
      { uid: ANNOUNCEMENT, documentId: "ann-b" },
      { uid: DOCUMENT, documentId: "doc-a" },
      { uid: DUTY_PLAN, documentId: "duty-a" },
      { uid: EVENT, documentId: "ev-a" },
      { uid: EVENT, documentId: "ev-b" },
      { uid: EVENT, documentId: "ev-c" },
      { uid: KPI, documentId: "kpi-a" },
      { uid: WIKI_PAGE, documentId: "wiki-a" },
    ]);
    expect(await documentsLinking(asHost(strapi), TEAM_LINKED_DOCUMENTS, [PLATFORM], "x")).toEqual([
      { uid: ANNOUNCEMENT, documentId: "ann-b" },
      { uid: ANNOUNCEMENT, documentId: "ann-c" },
      { uid: WIKI_PAGE, documentId: "wiki-b" },
    ]);
    expect(await documentsLinking(asHost(strapi), DEPARTMENT_LINKED_DOCUMENTS, [], "x")).toEqual(
      [],
    );
  });

  it("documentsLinking reads the link tables in bounded pages", async () => {
    const many = Array.from({ length: TARGETING_FLAGS_PAGE * 2 + 1 }, (_, i) => ({
      id: i + 1,
      documentId: `ann-${String(i).padStart(4, "0")}`,
      department: { id: ENG },
      publishedAt: null,
    }));
    const { strapi } = deleteHost({
      ...org(),
      [ANNOUNCEMENT]: many,
      [EVENT]: [],
      [DOCUMENT]: [],
      [DUTY_PLAN]: [],
      [KPI]: [],
      [WIKI_PAGE]: [],
    });
    const reads: unknown[] = [];
    const query = strapi.db.query;
    strapi.db.query = (uid: string) => {
      const inner = query(uid);
      return {
        ...inner,
        findMany: async (params) => {
          reads.push(params);
          return inner.findMany(params);
        },
      };
    };
    const refs = await documentsLinking(asHost(strapi), DEPARTMENT_LINKED_DOCUMENTS, [ENG], "x");
    expect(refs).toHaveLength(many.length);
    for (const params of reads as { limit?: number; where: { id?: { $in?: unknown[] } } }[]) {
      if (params.limit !== undefined)
        expect(params.limit).toBeLessThanOrEqual(TARGETING_FLAGS_PAGE);
      expect((params.where.id?.$in ?? []).length).toBeLessThanOrEqual(TARGETING_FLAGS_PAGE);
    }
  });

  it("compareDocumentRefs orders by uid, then documentId", () => {
    const refs = [
      { uid: EVENT, documentId: "a" },
      { uid: ANNOUNCEMENT, documentId: "b" },
      { uid: ANNOUNCEMENT, documentId: "a" },
    ];
    expect([...refs].sort(compareDocumentRefs)).toEqual([refs[2], refs[1], refs[0]]);
  });

  it("advanceRevisionsOf locks, then advances, each document in the given order", async () => {
    const { strapi } = deleteHost(org());
    const refs = [
      { uid: ANNOUNCEMENT, documentId: "ann-a" },
      { uid: EVENT, documentId: "ev-a" },
    ];
    expect(await advanceRevisionsOf(asHost(strapi), refs)).toBe(2);
    expect(revisions.log).toEqual([
      `lock ${ANNOUNCEMENT} ann-a`,
      `advance ${ANNOUNCEMENT} ann-a`,
      `lock ${EVENT} ev-a`,
      `advance ${EVENT} ev-a`,
    ]);
  });

  it("markAnnouncementsLinking raises audience and the marker on exactly the linked rows", async () => {
    const { strapi, values } = deleteHost(org());
    expect(await markAnnouncementsLinking(asHost(strapi), "team", [PLATFORM], "x")).toBe(3);
    expect(values(ANNOUNCEMENT, ["audience", "retargetRequired"])).toEqual([
      [1, "departments", true],
      [2, "departments", true],
      [3, "departments", null],
      [4, "departments", true],
      [5, "all", null],
    ]);
    // Idempotent: nothing left to raise.
    expect(await markAnnouncementsLinking(asHost(strapi), "team", [PLATFORM], "x")).toBe(0);
    expect(await markAnnouncementsLinking(asHost(strapi), "department", [], "x")).toBe(0);
  });

  it("flagEventsLinking raises notifyAudience on the rows linking the departments", async () => {
    const { strapi, values } = deleteHost(org());
    expect(await flagEventsLinking(asHost(strapi), [ENG], "x")).toBe(2);
    expect(values(EVENT, ["notifyAudience"])).toEqual([
      [1, "departments"],
      [2, "all"],
      [3, "departments"],
    ]);
  });
});
