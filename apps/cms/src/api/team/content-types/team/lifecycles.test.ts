import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANNOUNCEMENT,
  DEPARTMENT,
  TEAM,
  deleteHost,
} from "../../../../utils/targeting-flags.test.helper";
import lifecycles from "./lifecycles";

/**
 * The team delete hook (new in batch 15 lane 15D; decision 06 §D rule 13,
 * §N9; amendment rows A2 and A3): before the cascade, every announcement
 * row whose `team` is the deleted one gets `audience = 'departments'` and
 * `retargetRequired = true`, and the revision of each such announcement is
 * locked and advanced, ascending, before that write; on Postgres after the
 * team rows are locked. One transaction; a failing step fails the delete.
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
const PLATFORM = 30;
const DATA = 31;

function org() {
  return {
    [DEPARTMENT]: [{ id: ENG, documentId: "dep-eng" }],
    [TEAM]: [
      { id: PLATFORM, documentId: "team-platform", department: { id: ENG } },
      { id: DATA, documentId: "team-data", department: { id: ENG } },
    ],
    [ANNOUNCEMENT]: [
      // Engineering plus Platform: without the marker the whole of
      // Engineering would read it once the team is gone.
      {
        id: 1,
        documentId: "ann-z-eng-platform",
        audience: "departments",
        department: { id: ENG },
        team: { id: PLATFORM },
        publishedAt: null,
      },
      {
        id: 2,
        documentId: "ann-z-eng-platform",
        audience: "departments",
        department: { id: ENG },
        team: { id: PLATFORM },
        publishedAt: "2026-01-01",
      },
      // Platform only, a legacy row: D-PT01 needs the flag, the marker comes too.
      {
        id: 3,
        documentId: "ann-a-platform",
        audience: "all",
        team: { id: PLATFORM },
        publishedAt: null,
      },
      // Another team: untouched.
      {
        id: 4,
        documentId: "ann-data",
        audience: "departments",
        team: { id: DATA },
        publishedAt: null,
      },
      // Engineering, owned by it: a team delete does not touch it.
      {
        id: 5,
        documentId: "ann-eng",
        audience: "departments",
        department: { id: ENG },
        ownerDepartment: { id: ENG },
        publishedAt: null,
      },
    ],
  };
}

function setup(options: Parameters<typeof deleteHost>[1] = {}) {
  const host = deleteHost(org(), options);
  revisions.record = host.record;
  vi.stubGlobal("strapi", host.strapi);
  return host;
}

const deletePlatform = () => lifecycles.beforeDelete({ params: { where: { id: PLATFORM } } });

describe("team delete", () => {
  it("marks exactly the announcements that targeted the team", async () => {
    const { values } = setup();
    await deletePlatform();
    expect(values(ANNOUNCEMENT, ["audience", "retargetRequired"])).toEqual([
      [1, "departments", true],
      [2, "departments", true],
      [3, "departments", true],
      [4, "departments", null],
      [5, "departments", null],
    ]);
  });

  it("locks and advances their revisions, ascending, before the marker write", async () => {
    const { events } = setup();
    await deletePlatform();
    expect(events.filter((event) => /^(lock|advance|update) /.test(event))).toEqual([
      `lock ${ANNOUNCEMENT} ann-a-platform`,
      `advance ${ANNOUNCEMENT} ann-a-platform`,
      `lock ${ANNOUNCEMENT} ann-z-eng-platform`,
      `advance ${ANNOUNCEMENT} ann-z-eng-platform`,
      `update ${ANNOUNCEMENT}`,
    ]);
  });

  it("on Postgres locks the team rows before it reads the links", async () => {
    const { events } = setup({ dialect: "postgres" });
    await deletePlatform();
    const lock = events.indexOf(`lock-rows ${TEAM} [${PLATFORM}]`);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(events.findIndex((event) => event === "read announcements_team_lnk")).toBeGreaterThan(
      lock,
    );
  });

  it("logs what it restricted", async () => {
    const { strapi } = setup();
    await deletePlatform();
    expect(strapi.log.info).toHaveBeenCalledWith(
      "[targeting-flags] team delete: advanced the revision of 2 announcement(s) and marked 3 " +
        "announcement row(s) 'retargetRequired': they stay restricted (admins and editors only, " +
        "nobody notified) until re-targeted",
    );
  });

  it("beforeDeleteMany without a where covers every team; a miss does nothing", async () => {
    const all = setup();
    await lifecycles.beforeDeleteMany({ params: { where: null } });
    expect(all.events).toContain(`advance ${ANNOUNCEMENT} ann-data`);

    const none = setup();
    await lifecycles.beforeDelete({ params: { where: { id: 999 } } });
    expect(none.events.filter((event) => !event.startsWith("read "))).toEqual([]);
  });

  it("a failing marker write fails the delete", async () => {
    setup({ failOn: ANNOUNCEMENT });
    await expect(deletePlatform()).rejects.toThrow(`update of ${ANNOUNCEMENT} failed`);
  });

  it("an unknown link table refuses the delete before any write", async () => {
    const { events } = setup({ metadata: () => ({ attributes: {} }) });
    await expect(deletePlatform()).rejects.toThrow(
      "[targeting-flags] the link table of api::announcement.announcement.team is unknown; " +
        "refusing to delete a team without keeping its announcements restricted",
    );
    expect(events.filter((event) => /^(lock|advance|update) /.test(event))).toEqual([]);
  });
});
