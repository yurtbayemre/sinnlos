import { describe, expect, it } from "vitest";

import { createStrapiStub, type Row } from "../test/strapi-stub.test.helper";
import {
  NOTIFICATION_PRUNE_BATCH,
  NOTIFICATION_PRUNE_MAX_BATCHES,
  NOTIFICATION_RETENTION_DAYS,
  NOTIFICATION_UNREAD_RETENTION_DAYS,
  anchorSource,
  isAgedOutNotification,
  isPrunableNotification,
  notificationPruneCutoff,
  notificationPruneCutoffs,
  prunableNotificationWhere,
  pruneNotifications,
  pruneOrphanedAnchors,
  type AnchorJanitorStrapi,
  type NotificationJanitorStrapi,
} from "./prune-notifications";

/**
 * Notification retention (LF07, owner answer 2026-09-29 (b); v0.28 M11):
 * read rows go 90 days after they were read, unread rows 180 days after
 * they were created, fan-out anchor rows only once their source is gone in
 * every state (they are the re-publish dedup ledger,
 * utils/notification-source.ts). The pure rule and its where clause must
 * agree; the janitor re-checks every row with the rule before it deletes
 * it. The cascade of the recipient/actor link rows and the anchor pass are
 * pinned on both engines in integration/retention*.integration.test.ts.
 */

const NOTIFICATION = "api::notification.notification";
const NOW = new Date("2026-09-29T01:40:00.000Z");
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

/** Rows by label: every branch of the rule. */
const ROWS: Record<string, Omit<Row, "id">> = {
  readLongAgo: { readAt: daysAgo(100), createdAt: daysAgo(120) },
  readJustOverCutoff: { readAt: daysAgo(90.01), createdAt: daysAgo(95) },
  readExactlyAtCutoff: { readAt: daysAgo(90), createdAt: daysAgo(95) },
  readRecently: { readAt: daysAgo(10), createdAt: daysAgo(200) },
  unreadAncient: { readAt: null, createdAt: daysAgo(400) },
  unreadJustOverCutoff: { readAt: null, createdAt: daysAgo(180.01) },
  unreadExactlyAtCutoff: { readAt: null, createdAt: daysAgo(180) },
  unreadRecent: { readAt: null, createdAt: daysAgo(100) },
  anchoredReadLongAgo: {
    readAt: daysAgo(300),
    createdAt: daysAgo(300),
    sourceType: "announcement",
    sourceDocumentId: "ann00000000000000000000",
  },
  anchoredUnreadAncient: {
    readAt: null,
    createdAt: daysAgo(400),
    sourceType: "course",
    sourceDocumentId: "crs0@2025-01-01:expired",
  },
  halfAnchored: { readAt: daysAgo(300), createdAt: daysAgo(300), sourceDocumentId: "evt0" },
  // Cannot happen (readAt precedes createdAt), and is kept all the same.
  createdAfterCutoff: { readAt: daysAgo(100), createdAt: daysAgo(10) },
};

const PRUNABLE = ["readLongAgo", "readJustOverCutoff", "unreadAncient", "unreadJustOverCutoff"];

function stub(rows: Array<Omit<Row, "id">> = Object.values(ROWS)) {
  const strapi = createStrapiStub({
    tables: {
      [NOTIFICATION]: rows.map((row, index) => ({
        id: index + 1,
        type: "comment",
        title: `n${index + 1}`,
        sourceType: null,
        sourceDocumentId: null,
        ...row,
      })),
    },
  });
  return strapi;
}

/** The ids a pass-1 `deleteMany` names: `{ $and: [{ id: { $in } }, rule] }`. */
const idsOf = (params: Record<string, unknown>): number[] =>
  (params.where as { $and: Array<{ id?: { $in: number[] } }> }).$and[0].id?.$in ?? [];

const labelsLeft = (strapi: ReturnType<typeof stub>) => {
  const labels = Object.keys(ROWS);
  return strapi.tables[NOTIFICATION].map((row) => labels[row.id - 1]);
};

describe("the cutoffs", () => {
  it("are 90 days (read) and 180 days (unread) before now", () => {
    expect(NOTIFICATION_RETENTION_DAYS).toBe(90);
    expect(NOTIFICATION_UNREAD_RETENTION_DAYS).toBe(180);
    expect(notificationPruneCutoff(NOW).toISOString()).toBe(daysAgo(90));
    expect(notificationPruneCutoff(NOW, 1).toISOString()).toBe(daysAgo(1));
    const cutoffs = notificationPruneCutoffs(NOW);
    expect(cutoffs.read.toISOString()).toBe(daysAgo(90));
    expect(cutoffs.unread.toISOString()).toBe(daysAgo(180));
  });
});

describe("isPrunableNotification (pure)", () => {
  const cutoffs = notificationPruneCutoffs(NOW);

  it("prunes un-anchored rows read 90 or created unread 180 days ago, nothing else", () => {
    const prunable = Object.entries(ROWS)
      .filter(([, row]) => isPrunableNotification({ id: 1, ...row }, cutoffs))
      .map(([label]) => label);
    expect(prunable).toEqual(PRUNABLE);
  });

  it("ages anchored rows like the others (the anchor pass decides about their source)", () => {
    expect(isAgedOutNotification({ id: 1, ...ROWS.anchoredReadLongAgo }, cutoffs)).toBe(true);
    expect(isAgedOutNotification({ id: 1, ...ROWS.anchoredUnreadAncient }, cutoffs)).toBe(true);
    expect(isPrunableNotification({ id: 1, ...ROWS.anchoredUnreadAncient }, cutoffs)).toBe(false);
  });

  it("keeps rows it cannot read: no or unparseable dates", () => {
    for (const row of [
      { readAt: "yesterday", createdAt: daysAgo(200) },
      { readAt: daysAgo(200), createdAt: undefined },
      { readAt: 12345, createdAt: daysAgo(200) },
      { readAt: null, createdAt: "long ago" },
      { readAt: undefined, createdAt: undefined },
    ]) {
      expect(isPrunableNotification({ id: 1, ...row }, cutoffs), JSON.stringify(row)).toBe(false);
    }
  });

  it("accepts Date values as well as ISO strings", () => {
    const row = { id: 1, readAt: new Date(daysAgo(100)), createdAt: new Date(daysAgo(100)) };
    expect(isPrunableNotification(row, cutoffs)).toBe(true);
  });
});

describe("prunableNotificationWhere", () => {
  it("selects in the database exactly what the rule prunes", async () => {
    const strapi = stub();
    const rows = await strapi.db
      .query(NOTIFICATION)
      .findMany({ where: prunableNotificationWhere(notificationPruneCutoffs(NOW)) });
    const labels = Object.keys(ROWS);
    expect(rows.map((row) => labels[row.id - 1])).toEqual(PRUNABLE);
  });
});

describe("pruneNotifications", () => {
  it("deletes the prunable rows and keeps recent and anchored ones", async () => {
    const strapi = stub();
    await expect(pruneNotifications(strapi as NotificationJanitorStrapi, NOW)).resolves.toBe(
      PRUNABLE.length,
    );
    expect(labelsLeft(strapi)).toEqual(
      Object.keys(ROWS).filter((label) => !PRUNABLE.includes(label)),
    );
  });

  it("logs one line when it deleted something, none on a quiet night", async () => {
    const strapi = stub();
    await pruneNotifications(strapi as NotificationJanitorStrapi, NOW);
    expect(strapi.log.info.mock.calls).toEqual([
      [
        "[notification-janitor] pruned 4 notification(s) read more than 90 days ago " +
          "or unread for more than 180 days (fan-out anchors are kept)",
      ],
    ]);
    strapi.log.info.mockClear();
    await expect(pruneNotifications(strapi as NotificationJanitorStrapi, NOW)).resolves.toBe(0);
    expect(strapi.log.info).not.toHaveBeenCalled();
  });

  it("walks the rows in id pages and deletes page by page", async () => {
    const total = NOTIFICATION_PRUNE_BATCH * 2 + 7;
    const rows = Array.from({ length: total }, (_, i) =>
      i % 3 === 0 ? ROWS.unreadRecent : ROWS.readLongAgo,
    );
    const strapi = stub(rows);
    const prunable = rows.filter((row) => row === ROWS.readLongAgo).length;
    await expect(pruneNotifications(strapi as NotificationJanitorStrapi, NOW)).resolves.toBe(
      prunable,
    );
    expect(strapi.tables[NOTIFICATION]).toHaveLength(total - prunable);
    const deletes = strapi.calls.filter((call) => call.method === "deleteMany");
    expect(deletes.length).toBeGreaterThan(1);
    for (const call of deletes) {
      const ids = idsOf(call.params as Record<string, unknown>);
      expect(ids.length).toBeLessThanOrEqual(NOTIFICATION_PRUNE_BATCH);
    }
  });

  it("re-checks the rule in the delete: a row read meanwhile keeps its 90 days", async () => {
    const strapi = stub([ROWS.unreadAncient, ROWS.readLongAgo]);
    const query = strapi.db.query.bind(strapi.db);
    strapi.db.query = ((uid: string) => {
      const inner = query(uid);
      return {
        ...inner,
        findMany: async (params: Parameters<typeof inner.findMany>[0]) => {
          const rows = await inner.findMany(params);
          // markAllRead lands between the page read and its delete.
          strapi.tables[NOTIFICATION][0].readAt = NOW.toISOString();
          return rows;
        },
      };
    }) as typeof strapi.db.query;
    await expect(pruneNotifications(strapi as NotificationJanitorStrapi, NOW)).resolves.toBe(1);
    expect(strapi.tables[NOTIFICATION].map((row) => row.id)).toEqual([1]);
  });

  it("stops after NOTIFICATION_PRUNE_MAX_BATCHES pages; the rest waits for the next night", async () => {
    const pageSize = NOTIFICATION_PRUNE_BATCH;
    let reads = 0;
    const strapi: NotificationJanitorStrapi = {
      db: {
        query: () => ({
          findMany: async () => {
            reads += 1;
            return Array.from({ length: pageSize }, (_, i) => ({
              id: reads * pageSize + i,
              ...ROWS.readLongAgo,
            }));
          },
          deleteMany: async (params: Record<string, unknown>) => ({
            count: idsOf(params).length,
          }),
        }),
      },
      log: { info: () => {} },
    };
    await expect(pruneNotifications(strapi, NOW)).resolves.toBe(
      NOTIFICATION_PRUNE_MAX_BATCHES * pageSize,
    );
    expect(reads).toBe(NOTIFICATION_PRUNE_MAX_BATCHES);
  });

  it("never deletes a row the rule refuses, even when the database returns it", async () => {
    const deleted: number[][] = [];
    const strapi: NotificationJanitorStrapi = {
      db: {
        query: () => ({
          findMany: async () => [
            { id: 1, ...ROWS.readLongAgo },
            { id: 2, ...ROWS.anchoredReadLongAgo },
            { id: 3, ...ROWS.unreadRecent },
            { id: 4, ...ROWS.halfAnchored },
          ],
          deleteMany: async (params: Record<string, unknown>) => {
            const ids = idsOf(params);
            deleted.push(ids);
            return { count: ids.length };
          },
        }),
      },
      log: { info: () => {} },
    };
    await pruneNotifications(strapi, NOW);
    expect(deleted).toEqual([[1]]);
  });
});

describe("anchorSource (pure)", () => {
  it("names the document an announcement, event or training anchor depends on", () => {
    expect(anchorSource({ sourceType: "announcement", sourceDocumentId: "a1" })).toEqual({
      uid: "api::announcement.announcement",
      documentId: "a1",
    });
    expect(anchorSource({ sourceType: "event", sourceDocumentId: "e1" })).toEqual({
      uid: "api::event.event",
      documentId: "e1",
    });
    expect(
      anchorSource({ sourceType: "course", sourceDocumentId: "c0urse1@2026-10-31:soon" }),
    ).toEqual({ uid: "api::course.course", documentId: "c0urse1" });
    expect(
      anchorSource({ sourceType: "course", sourceDocumentId: "c1@2026-10-31:expired" }),
    ).toEqual({ uid: "api::course.course", documentId: "c1" });
  });

  it("names nothing for a half-set, unknown or malformed anchor (kept)", () => {
    for (const row of [
      { sourceType: null, sourceDocumentId: "a1" },
      { sourceType: "announcement", sourceDocumentId: null },
      { sourceType: "announcement", sourceDocumentId: "" },
      { sourceType: "announcement", sourceDocumentId: " a1" },
      { sourceType: "kudos", sourceDocumentId: "k1" },
      // A course anchor is never the bare course id.
      { sourceType: "course", sourceDocumentId: "c1" },
      { sourceType: "course", sourceDocumentId: "c1@2026-10-31" },
      { sourceType: "course", sourceDocumentId: "c1@31.10.2026:soon" },
      { sourceType: "course", sourceDocumentId: "c1@2026-10-31:later" },
      { sourceType: "course", sourceDocumentId: "@2026-10-31:soon" },
    ]) {
      expect(anchorSource(row), JSON.stringify(row)).toBeNull();
    }
  });
});

describe("pruneOrphanedAnchors", () => {
  /** A fake with the distinct read, the existence lookups and the deletes. */
  function anchorHost(pairs: unknown[], existing: Record<string, string[]>) {
    const deletes: Array<Record<string, unknown>> = [];
    const lookups: Array<{ uid: string; where: unknown }> = [];
    const strapi = {
      db: {
        metadata: {
          get: () => ({
            tableName: "notifications",
            attributes: {
              sourceType: { columnName: "source_type" },
              sourceDocumentId: { columnName: "source_document_id" },
            },
          }),
        },
        getConnection: (table: string) => {
          expect(table).toBe("notifications");
          return {
            distinct: (...columns: string[]) => {
              expect(columns).toEqual([
                "source_type as sourceType",
                "source_document_id as sourceDocumentId",
              ]);
              return { where: async () => pairs };
            },
          };
        },
        query: (uid: string) => ({
          findMany: async ({ where }: { where: { documentId: { $in: string[] } } }) => {
            lookups.push({ uid, where });
            return where.documentId.$in
              .filter((id) => (existing[uid] ?? []).includes(id))
              .map((documentId) => ({ documentId }));
          },
          deleteMany: async ({ where }: Record<string, unknown>) => {
            deletes.push(where as Record<string, unknown>);
            return { count: 2 };
          },
        }),
      },
      log: { info: () => {} },
    };
    return { strapi: strapi as unknown as AnchorJanitorStrapi, deletes, lookups };
  }

  it("deletes the aged anchors of gone sources only, by type, and keeps everything else", async () => {
    const { strapi, deletes } = anchorHost(
      [
        { sourceType: "announcement", sourceDocumentId: "live-ann" },
        { sourceType: "announcement", sourceDocumentId: "gone-ann" },
        { sourceType: "event", sourceDocumentId: "gone-evt" },
        { sourceType: "course", sourceDocumentId: "livecourse@2026-01-01:soon" },
        { sourceType: "course", sourceDocumentId: "gonecourse@2026-01-01:soon" },
        { sourceType: "course", sourceDocumentId: "gonecourse@2026-02-01:expired" },
        { sourceType: "course", sourceDocumentId: "malformed" },
        { sourceType: null, sourceDocumentId: "half" },
      ],
      {
        "api::announcement.announcement": ["live-ann"],
        "api::course.course": ["livecourse"],
      },
    );
    await expect(pruneOrphanedAnchors(strapi, NOW)).resolves.toBe(6);
    const aged = prunableNotificationWhere(notificationPruneCutoffs(NOW)).$and as unknown[];
    expect(deletes).toEqual([
      {
        $and: [
          { sourceType: "announcement" },
          { sourceDocumentId: { $in: ["gone-ann"] } },
          aged[0],
        ],
      },
      { $and: [{ sourceType: "event" }, { sourceDocumentId: { $in: ["gone-evt"] } }, aged[0]] },
      {
        $and: [
          { sourceType: "course" },
          {
            sourceDocumentId: {
              $in: ["gonecourse@2026-01-01:soon", "gonecourse@2026-02-01:expired"],
            },
          },
          aged[0],
        ],
      },
    ]);
  });

  it("deletes nothing while every source exists", async () => {
    const { strapi, deletes } = anchorHost([{ sourceType: "event", sourceDocumentId: "e1" }], {
      "api::event.event": ["e1"],
    });
    await expect(pruneOrphanedAnchors(strapi, NOW)).resolves.toBe(0);
    expect(deletes).toEqual([]);
  });
});
