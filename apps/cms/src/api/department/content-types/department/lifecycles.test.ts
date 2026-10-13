import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANNOUNCEMENT,
  DEPARTMENT,
  DOCUMENT,
  EVENT,
  POLL,
  QUICK_LINK,
  TEAM,
  deleteHost,
} from "../../../../utils/targeting-flags.test.helper";
import lifecycles from "./lifecycles";

/**
 * The department delete hook as a whole (batch 15 lane 15D; decision 06
 * §D rule 13, §N9; amendment rows A2 and A3), on the shared stub with the
 * link tables the hook reads and the revision API mocked:
 *   - before the cascade, the rows that linked the deleted department are
 *     restricted: polls, documents and quick links (`audience`),
 *     announcements (`audience` and the `retargetRequired` marker), events
 *     (`notifyAudience`);
 *   - every announcement, event and document that linked it (`department`,
 *     `departments`, `ownerDepartment`) has its revision locked and
 *     advanced, in ascending (uid, documentId) order, before any flag
 *     write; on Postgres after the department rows are locked;
 *   - one transaction; a failing step fails the delete.
 * The mechanics of the older halves are pinned in poll-department-delete
 * .test.ts and department-delete-restrict.test.ts; the real chain on
 * SQLite and Postgres in integration/targeting-fail-closed.integration
 * .test.ts.
 */

const revisions = vi.hoisted(() => ({ record: (_event: string): void => undefined }));
vi.mock("../../../../utils/document-lock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../utils/document-lock")>()),
  lockDocument: vi.fn(async (_strapi: unknown, uid: string, documentId: string) => {
    revisions.record(`lock ${uid} ${documentId}`);
    return 0;
  }),
  advanceRevision: vi.fn(async (_strapi: unknown, uid: string, documentId: string) => {
    revisions.record(`advance ${uid} ${documentId}`);
    return 1;
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const ENG = 10;
const SALES = 11;
const PLATFORM = 30;

function org() {
  return {
    [DEPARTMENT]: [
      { id: ENG, documentId: "dep-eng", name: "Engineering" },
      { id: SALES, documentId: "dep-sales", name: "Sales" },
    ],
    [TEAM]: [{ id: PLATFORM, documentId: "team-platform", department: { id: ENG } }],
    [ANNOUNCEMENT]: [
      // Engineering plus Platform: the team remains after the delete.
      {
        id: 1,
        documentId: "ann-eng-team",
        audience: "departments",
        department: { id: ENG },
        team: { id: PLATFORM },
        publishedAt: null,
      },
      {
        id: 2,
        documentId: "ann-eng-team",
        audience: "departments",
        department: { id: ENG },
        team: { id: PLATFORM },
        publishedAt: "2026-01-01",
      },
      // Engineering plus roles, a legacy row with Audience 'all'.
      {
        id: 3,
        documentId: "ann-eng-roles",
        audience: "all",
        department: { id: ENG },
        audienceRoles: [{ id: 5 }],
        publishedAt: null,
      },
      // Sales, owned by Engineering: no marker, a revision advance.
      {
        id: 4,
        documentId: "ann-owned",
        audience: "departments",
        department: { id: SALES },
        ownerDepartment: { id: ENG },
        publishedAt: null,
      },
      // Sales only: untouched.
      {
        id: 5,
        documentId: "ann-sales",
        audience: "departments",
        department: { id: SALES },
        publishedAt: null,
      },
    ],
    [EVENT]: [
      {
        id: 1,
        documentId: "ev-eng",
        notifyAudience: "all",
        departments: [{ id: ENG }],
        publishedAt: null,
      },
      {
        id: 2,
        documentId: "ev-eng",
        notifyAudience: null,
        departments: [{ id: ENG }],
        publishedAt: "2026-01-01",
      },
      {
        id: 3,
        documentId: "ev-both",
        notifyAudience: "departments",
        departments: [{ id: ENG }, { id: SALES }],
        publishedAt: null,
      },
      {
        id: 4,
        documentId: "ev-sales",
        notifyAudience: "all",
        departments: [{ id: SALES }],
        publishedAt: null,
      },
    ],
    [DOCUMENT]: [
      {
        id: 1,
        documentId: "doc-eng",
        audience: "all",
        departments: [{ id: ENG }],
        publishedAt: null,
      },
      {
        id: 2,
        documentId: "doc-owned",
        audience: "all",
        departments: [],
        ownerDepartment: { id: ENG },
        publishedAt: null,
      },
      {
        id: 3,
        documentId: "doc-sales",
        audience: "departments",
        departments: [{ id: SALES }],
        publishedAt: null,
      },
    ],
    [QUICK_LINK]: [
      {
        id: 1,
        documentId: "ql-eng",
        audience: "all",
        departments: [{ id: ENG }],
        publishedAt: null,
      },
    ],
    [POLL]: [
      {
        id: 1,
        documentId: "poll-eng",
        audience: "all",
        departments: [{ id: ENG }],
        publishedAt: null,
      },
    ],
  };
}

function setup(options: Parameters<typeof deleteHost>[1] = {}) {
  const host = deleteHost(org(), options);
  revisions.record = host.record;
  const transaction = vi.spyOn(host.strapi.db, "transaction");
  vi.stubGlobal("strapi", host.strapi);
  return { ...host, transaction };
}

const deleteEngineering = () => lifecycles.beforeDelete({ params: { where: { id: ENG } } });

describe("department delete: what stays restricted", () => {
  it("marks the announcements that targeted the department, and only them", async () => {
    const { values } = setup();
    await deleteEngineering();
    expect(values(ANNOUNCEMENT, ["audience", "retargetRequired"])).toEqual([
      [1, "departments", true],
      [2, "departments", true],
      [3, "departments", true],
      [4, "departments", null],
      [5, "departments", null],
    ]);
  });

  it("flags the events that linked it to notify 'departments'", async () => {
    const { values } = setup();
    await deleteEngineering();
    expect(values(EVENT, ["notifyAudience"])).toEqual([
      [1, "departments"],
      [2, "departments"],
      [3, "departments"],
      [4, "all"],
    ]);
  });

  it("keeps the batch-12 and poll flags on documents, quick links and polls", async () => {
    const { values } = setup();
    await deleteEngineering();
    expect(values(DOCUMENT, ["audience"])).toEqual([
      [1, "departments"],
      [2, "all"],
      [3, "departments"],
    ]);
    expect(values(QUICK_LINK, ["audience"])).toEqual([[1, "departments"]]);
    expect(values(POLL, ["audience"])).toEqual([[1, "departments"]]);
  });

  it("logs what it restricted", async () => {
    const { strapi } = setup();
    await deleteEngineering();
    expect(strapi.log.info).toHaveBeenCalledWith(
      "[targeting-flags] department delete: advanced the revision of 7 " +
        "announcement/event/document(s); marked 3 announcement row(s) 'retargetRequired' and " +
        "flagged 2 event row(s) to notify 'departments': they stay restricted (admins and " +
        "editors only, nobody notified) until re-targeted",
    );
  });
});

describe("department delete: revisions (§D rule 13)", () => {
  it("locks and advances every linked announcement, event and document, ascending, before any flag write", async () => {
    const { events } = setup();
    await deleteEngineering();
    const revisionEvents = events.filter((event) => /^(lock|advance) /.test(event));
    expect(revisionEvents).toEqual(
      [
        `${ANNOUNCEMENT} ann-eng-roles`,
        `${ANNOUNCEMENT} ann-eng-team`,
        `${ANNOUNCEMENT} ann-owned`,
        `${DOCUMENT} doc-eng`,
        `${DOCUMENT} doc-owned`,
        `${EVENT} ev-both`,
        `${EVENT} ev-eng`,
      ].flatMap((ref) => [`lock ${ref}`, `advance ${ref}`]),
    );
    const lastRevision = events.map((event) => event.startsWith("advance ")).lastIndexOf(true);
    const firstWrite = events.findIndex((event) => event.startsWith("update "));
    expect(firstWrite).toBeGreaterThan(lastRevision);
  });

  it("on Postgres locks the department rows before it reads any link", async () => {
    const { events } = setup({ dialect: "postgres" });
    await deleteEngineering();
    const lock = events.indexOf(`lock-rows ${DEPARTMENT} [${ENG}]`);
    expect(lock).toBeGreaterThanOrEqual(0);
    const firstLinkRead = events.findIndex((event) => /^read \w+_lnk$/.test(event));
    expect(firstLinkRead).toBeGreaterThan(lock);
  });

  it("does nothing when the delete matches no department", async () => {
    const { events, values } = setup();
    await lifecycles.beforeDelete({ params: { where: { id: 999 } } });
    expect(events.filter((event) => !event.startsWith("read "))).toEqual([]);
    expect(values(ANNOUNCEMENT, ["retargetRequired"]).map((row) => row[1])).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("both hooks take the delete's own where (moved from the poll and FX29 suites)", async () => {
    for (const hook of ["beforeDelete", "beforeDeleteMany"] as const) {
      const { values, events } = setup();
      await lifecycles[hook]({ params: { where: { id: { $in: [SALES] } } } });
      expect(values(POLL, ["audience"]), hook).toEqual([[1, "all"]]);
      expect(values(QUICK_LINK, ["audience"]), hook).toEqual([[1, "all"]]);
      expect(values(EVENT, ["notifyAudience"]), hook).toEqual([
        [1, "all"],
        [2, null],
        [3, "departments"],
        [4, "departments"],
      ]);
      expect(values(ANNOUNCEMENT, ["retargetRequired"]), hook).toEqual([
        [1, null],
        [2, null],
        [3, null],
        [4, true],
        [5, true],
      ]);
      expect(
        events.filter((event) => event.startsWith("advance ")),
        hook,
      ).toEqual([
        `advance ${ANNOUNCEMENT} ann-owned`,
        `advance ${ANNOUNCEMENT} ann-sales`,
        `advance ${DOCUMENT} doc-sales`,
        `advance ${EVENT} ev-both`,
        `advance ${EVENT} ev-sales`,
      ]);
    }
  });

  it("beforeDeleteMany without a where covers every department", async () => {
    const { events } = setup();
    await lifecycles.beforeDeleteMany({ params: { where: null } });
    expect(events).toContain(`advance ${ANNOUNCEMENT} ann-sales`);
    expect(events).toContain(`advance ${EVENT} ev-sales`);
  });
});

describe("department delete: one transaction, fail closed", () => {
  it("runs inside one transaction (joining the delete's)", async () => {
    const { transaction } = setup();
    await deleteEngineering();
    expect(transaction.mock.calls.length).toBeGreaterThanOrEqual(1);
    // The first call is the hook's own; everything else joins it.
    const first = transaction.mock.invocationCallOrder[0];
    expect(Math.min(...transaction.mock.invocationCallOrder)).toBe(first);
  });

  it.each([ANNOUNCEMENT, EVENT, DOCUMENT, POLL])(
    "a failing %s flag write fails the delete",
    async (uid) => {
      setup({ failOn: uid });
      await expect(deleteEngineering()).rejects.toThrow(`update of ${uid} failed`);
    },
  );

  it("an unknown link table refuses the delete before any write", async () => {
    const { events } = setup({
      metadata: (uid) => (uid === EVENT ? { attributes: {} } : undefined),
    });
    await expect(deleteEngineering()).rejects.toThrow(
      /link table of api::(announcement\.announcement|event\.event)\.\w+ is unknown; refusing to delete a department/,
    );
    expect(events.filter((event) => /^(lock|advance|update) /.test(event))).toEqual([]);
  });
});
