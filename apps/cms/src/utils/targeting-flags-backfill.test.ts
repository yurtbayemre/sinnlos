import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  minimalType,
  openDocumentService,
  type OpenDocumentService,
} from "../test/document-service.test.helper";
import {
  TARGETING_FLAGS_CHUNK,
  backfillTargetingFlags,
  idOf,
  linkTableOf,
  type TargetingFlagsBackfillHost,
} from "./targeting-flags-backfill";

/**
 * The targeting-flag backfill (decision 06 §N9, amendment row A5; plan item
 * 6 with the twin rule of review finding 1), on the real query engine
 * (SQLite) with the announcement, event, department and team shapes of the
 * app. The batch-14 discard regression on the real schemas is in
 * integration/targeting-flags-backfill.
 */

const ANNOUNCEMENT = "api::announcement.announcement";
const EVENT = "api::event.event";
const DEPARTMENT = "api::department.department";
const TEAM = "api::team.team";

let open: OpenDocumentService;
let host: TargetingFlagsBackfillHost;
let engineering: string;
let platform: string;

beforeEach(async () => {
  open = await openDocumentService([
    minimalType(DEPARTMENT, "departments", { name: { type: "string" } }, false),
    minimalType(TEAM, "teams", { name: { type: "string" } }, false),
    minimalType(ANNOUNCEMENT, "announcements", {
      title: { type: "string" },
      audience: { type: "enumeration", enum: ["all", "departments"], default: "all" },
      retargetRequired: { type: "boolean", default: false },
      department: { type: "relation", relation: "manyToOne", target: DEPARTMENT },
      team: { type: "relation", relation: "manyToOne", target: TEAM },
    }),
    minimalType(EVENT, "events", {
      title: { type: "string" },
      notifyAudience: { type: "enumeration", enum: ["all", "departments"], default: "all" },
      departments: { type: "relation", relation: "manyToMany", target: DEPARTMENT },
    }),
  ]);
  engineering = (await open.service(DEPARTMENT).create({ data: { name: "Engineering" } }))
    .documentId;
  platform = (await open.service(TEAM).create({ data: { name: "Platform" } })).documentId;
  host = open.strapi as unknown as TargetingFlagsBackfillHost;
}, 30_000);

afterEach(async () => {
  await open.close();
});

/** Raw SQL, as the pre-upgrade database or the batch-14 image leaves rows. */
const sql = (statement: string, bindings: unknown[] = []) =>
  open.db.connection.raw(statement, bindings);

const flags = async (table: "announcements" | "events", documentId: string) => {
  const rows = (await sql(`SELECT * FROM ${table} WHERE document_id = ? ORDER BY id`, [
    documentId,
  ])) as Array<Record<string, unknown>>;
  return rows.map((row) =>
    table === "events"
      ? { published: row.published_at !== null, notifyAudience: row.notify_audience }
      : {
          published: row.published_at !== null,
          audience: row.audience,
          retargetRequired: row.retarget_required === null ? null : Boolean(row.retarget_required),
        },
  );
};

/** A published event with both rows' notify_audience set NULL (the state after the upgrade). */
async function legacyEvent(data: Record<string, unknown>) {
  const event = await open
    .service(EVENT)
    .create({ data: { title: "E", ...data }, status: "published" });
  await sql("UPDATE events SET notify_audience = NULL WHERE document_id = ?", [event.documentId]);
  return event.documentId as string;
}

async function legacyAnnouncement(data: Record<string, unknown>, audience: string | null = "all") {
  const announcement = await open
    .service(ANNOUNCEMENT)
    .create({ data: { title: "A", ...data }, status: "published" });
  await sql(
    "UPDATE announcements SET audience = ?, retarget_required = NULL WHERE document_id = ?",
    [audience, announcement.documentId],
  );
  return announcement.documentId as string;
}

describe("backfillTargetingFlags", () => {
  it("raises announcement audience on rows that link a department or a team, on both twins", async () => {
    const byDepartment = await legacyAnnouncement({ department: engineering });
    const byTeam = await legacyAnnouncement({ team: platform }, null);
    const open_ = await legacyAnnouncement({});
    const counts = await backfillTargetingFlags(host);
    expect(counts.announcementAudience).toBe(4);
    for (const documentId of [byDepartment, byTeam]) {
      expect((await flags("announcements", documentId)).map((row) => row.audience)).toEqual([
        "departments",
        "departments",
      ]);
    }
    expect((await flags("announcements", open_)).map((row) => row.audience)).toEqual([
      "all",
      "all",
    ]);
  });

  it("NULL event rows: linked → departments, unlinked → all", async () => {
    const linked = await legacyEvent({ departments: [engineering] });
    const unlinked = await legacyEvent({});
    const counts = await backfillTargetingFlags(host);
    expect(counts).toMatchObject({ eventLinked: 2, eventTwins: 0, eventAll: 2 });
    expect((await flags("events", linked)).map((row) => row.notifyAudience)).toEqual([
      "departments",
      "departments",
    ]);
    expect((await flags("events", unlinked)).map((row) => row.notifyAudience)).toEqual([
      "all",
      "all",
    ]);
  });

  it("raises an 'all' event row that links a department; never lowers a flag", async () => {
    const linkedAll = await legacyEvent({ departments: [engineering] });
    await sql("UPDATE events SET notify_audience = 'all' WHERE document_id = ?", [linkedAll]);
    const restricted = await legacyEvent({});
    await sql("UPDATE events SET notify_audience = 'departments' WHERE document_id = ?", [
      restricted,
    ]);
    await backfillTargetingFlags(host);
    expect((await flags("events", linkedAll)).map((row) => row.notifyAudience)).toEqual([
      "departments",
      "departments",
    ]);
    // Flag-only restriction (its departments were deleted): stays.
    expect((await flags("events", restricted)).map((row) => row.notifyAudience)).toEqual([
      "departments",
      "departments",
    ]);
  });

  it("the twin rule: a NULL unlinked event row takes 'departments' from its other row (the batch-14 discard)", async () => {
    const restricted = await legacyEvent({});
    // Both rows restricted by the flag only; the old image's discard rebuilt the draft without it.
    await sql("UPDATE events SET notify_audience = 'departments' WHERE document_id = ?", [
      restricted,
    ]);
    await sql(
      "UPDATE events SET notify_audience = NULL WHERE document_id = ? AND published_at IS NULL",
      [restricted],
    );
    const counts = await backfillTargetingFlags(host);
    expect(counts).toMatchObject({ eventTwins: 1, eventAll: 0 });
    expect(await flags("events", restricted)).toEqual([
      { published: false, notifyAudience: "departments" },
      { published: true, notifyAudience: "departments" },
    ]);
  });

  it("a row flagged in this run never acts as a twin; both twins NULL without links → all (the residual)", async () => {
    // Draft unlinked and NULL, published linked and NULL: the published row is
    // raised by its link in this run, the draft keeps its own content's flag.
    const mixed = await legacyEvent({ departments: [engineering] });
    await open.service(EVENT).update({ documentId: mixed, data: { departments: [] } });
    await sql("UPDATE events SET notify_audience = NULL WHERE document_id = ?", [mixed]);
    const lost = await legacyEvent({});
    await backfillTargetingFlags(host);
    expect(await flags("events", mixed)).toEqual([
      { published: false, notifyAudience: "all" },
      { published: true, notifyAudience: "departments" },
    ]);
    expect((await flags("events", lost)).map((row) => row.notifyAudience)).toEqual(["all", "all"]);
  });

  it("a NULL retargetRequired takes true from its twin and is never set otherwise", async () => {
    const marked = await legacyAnnouncement({});
    await sql(
      "UPDATE announcements SET retarget_required = 1, audience = 'departments' WHERE document_id = ? AND published_at IS NOT NULL",
      [marked],
    );
    const unmarked = await legacyAnnouncement({});
    const counts = await backfillTargetingFlags(host);
    expect(counts.announcementRetargetTwins).toBe(1);
    expect((await flags("announcements", marked)).map((row) => row.retargetRequired)).toEqual([
      true,
      true,
    ]);
    expect((await flags("announcements", unmarked)).map((row) => row.retargetRequired)).toEqual([
      null,
      null,
    ]);
  });

  it("is idempotent: the second run changes nothing and logs nothing", async () => {
    await legacyEvent({ departments: [engineering] });
    await legacyAnnouncement({ department: engineering });
    await backfillTargetingFlags(host);
    const log = open.strapi.log.info;
    log.mockClear();
    expect(await backfillTargetingFlags(host)).toEqual({
      announcementAudience: 0,
      announcementRetargetTwins: 0,
      eventLinked: 0,
      eventTwins: 0,
      eventAll: 0,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("logs its counts", async () => {
    await legacyEvent({ departments: [engineering] });
    await backfillTargetingFlags(host);
    expect(open.strapi.log.info).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[targeting-flags\] announcements: audience 'departments' on 0 row\(s\)/,
      ),
    );
  });

  it("pages through more rows than one chunk", async () => {
    for (let index = 0; index <= TARGETING_FLAGS_CHUNK; index += 1) {
      await open
        .service(EVENT)
        .create({ data: { title: `E${index}`, departments: [engineering] } });
    }
    await sql("UPDATE events SET notify_audience = NULL");
    const counts = await backfillTargetingFlags(host);
    expect(counts.eventLinked).toBe(TARGETING_FLAGS_CHUNK + 1);
  }, 30_000);

  it("an error rolls everything back and throws a [targeting-flags] error (fail closed)", async () => {
    const linked = await legacyEvent({ departments: [engineering] });
    const announcement = await legacyAnnouncement({ department: engineering });
    const failing: TargetingFlagsBackfillHost = {
      ...host,
      db: {
        ...host.db,
        transaction: host.db.transaction.bind(host.db),
        metadata: host.db.metadata,
        query: (uid: string) => {
          const query = host.db.query(uid);
          if (uid !== EVENT) return query;
          return {
            findMany: query.findMany.bind(query),
            updateMany: vi.fn(async () => {
              throw new Error("disk full");
            }),
          };
        },
      },
    };
    await expect(backfillTargetingFlags(failing)).rejects.toThrow(
      /^\[targeting-flags\] could not backfill .*\(disk full\); nothing was changed/,
    );
    // The announcement update ran first and was rolled back with the rest.
    expect((await flags("announcements", announcement)).map((row) => row.audience)).toEqual([
      "all",
      "all",
    ]);
    expect((await flags("events", linked)).map((row) => row.notifyAudience)).toEqual([null, null]);
  });

  it("refuses to run without a link table it needs", () => {
    expect(() => linkTableOf(host, ANNOUNCEMENT, "nothing")).toThrow(
      /the link table of api::announcement.announcement.nothing is unknown/,
    );
  });
});

describe("row ids as a driver hands them back", () => {
  it("reads integers and numeric strings (a bigint column), nothing else", () => {
    expect(idOf(7)).toBe(7);
    expect(idOf("7")).toBe(7);
    expect(idOf("9007199254740991")).toBe(9_007_199_254_740_991);
    for (const value of [
      0,
      -1,
      1.5,
      "0",
      "07",
      "7a",
      "",
      null,
      undefined,
      {},
      "99999999999999999",
    ]) {
      expect(idOf(value), JSON.stringify(value)).toBeNull();
    }
  });

  /** A host whose link table answers its ids as strings, like a bigint column on pg. */
  function stringIdHost(linkRows: Record<string, unknown>[]) {
    const updates: Array<{ uid: string; params: Record<string, unknown> }> = [];
    const joinTable = (name: string, column: string) => ({
      joinTable: { name, joinColumn: { name: column } },
    });
    const metadata: Record<string, unknown> = {
      [ANNOUNCEMENT]: {
        attributes: {
          department: joinTable("ann_department", "announcement_id"),
          team: joinTable("ann_team", "announcement_id"),
        },
      },
      [EVENT]: { attributes: { departments: joinTable("ev_departments", "event_id") } },
    };
    const host = {
      db: {
        metadata: { get: (uid: string) => metadata[uid] },
        transaction: async <T>(callback: () => Promise<T>) => callback(),
        query: (uid: string) => ({
          findMany: async () => (uid === "ann_department" ? linkRows : []),
          updateMany: async (params: Record<string, unknown>) => {
            updates.push({ uid, params });
            return { count: 1 };
          },
        }),
      },
      log: { info: vi.fn() },
    } as unknown as TargetingFlagsBackfillHost;
    return { host, updates };
  }

  it("raises the rows a string-id link table names", async () => {
    const { host, updates } = stringIdHost([{ id: "1", announcement_id: "7" }]);
    await backfillTargetingFlags(host);
    const raise = updates.find(
      (update) => update.uid === ANNOUNCEMENT && "audience" in (update.params.data as object),
    );
    expect(raise?.params.where).toMatchObject({ id: { $in: [7] } });
  });

  it("refuses a row without a usable id instead of skipping its flag", async () => {
    const { host } = stringIdHost([{ id: "1", announcement_id: "seven" }]);
    await expect(backfillTargetingFlags(host)).rejects.toThrow(
      /^\[targeting-flags\] could not backfill .*ann_department returned a row without a numeric announcement_id/,
    );
  });
});
