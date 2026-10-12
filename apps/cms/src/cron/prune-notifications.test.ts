import { describe, expect, it } from "vitest";

import { createStrapiStub, type Row } from "../test/strapi-stub.test.helper";
import {
  NOTIFICATION_PRUNE_BATCH,
  NOTIFICATION_PRUNE_MAX_BATCHES,
  NOTIFICATION_RETENTION_DAYS,
  isPrunableNotification,
  notificationPruneCutoff,
  prunableNotificationWhere,
  pruneNotifications,
  type NotificationJanitorStrapi,
} from "./prune-notifications";

/**
 * LF07 notification retention (owner answer 2026-09-29 (b)): read rows go
 * 90 days after they were read, unread rows never, fan-out anchor rows
 * never (they are the re-publish dedup ledger, utils/notification-source.ts).
 * The pure rule and its where clause must agree; the janitor re-checks
 * every row with the rule before it deletes it. The cascade of the
 * recipient/actor link rows is pinned on both engines in
 * integration/retention.integration.test.ts.
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
  anchoredReadLongAgo: {
    readAt: daysAgo(300),
    createdAt: daysAgo(300),
    sourceType: "announcement",
    sourceDocumentId: "ann00000000000000000000",
  },
  halfAnchored: { readAt: daysAgo(300), createdAt: daysAgo(300), sourceDocumentId: "evt0" },
  // Cannot happen (readAt precedes createdAt), and is kept all the same.
  createdAfterCutoff: { readAt: daysAgo(100), createdAt: daysAgo(10) },
};

const PRUNABLE = ["readLongAgo", "readJustOverCutoff"];

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

const labelsLeft = (strapi: ReturnType<typeof stub>) => {
  const labels = Object.keys(ROWS);
  return strapi.tables[NOTIFICATION].map((row) => labels[row.id - 1]);
};

describe("notificationPruneCutoff", () => {
  it("is 90 days before now", () => {
    expect(NOTIFICATION_RETENTION_DAYS).toBe(90);
    expect(notificationPruneCutoff(NOW).toISOString()).toBe(daysAgo(90));
    expect(notificationPruneCutoff(NOW, 1).toISOString()).toBe(daysAgo(1));
  });
});

describe("isPrunableNotification (pure)", () => {
  const cutoff = notificationPruneCutoff(NOW);

  it("prunes read rows read (and created) before the cutoff, nothing else", () => {
    const prunable = Object.entries(ROWS)
      .filter(([, row]) => isPrunableNotification({ id: 1, ...row }, cutoff))
      .map(([label]) => label);
    expect(prunable).toEqual(PRUNABLE);
  });

  it("keeps rows it cannot read: no or unparseable dates", () => {
    for (const row of [
      { readAt: "yesterday", createdAt: daysAgo(200) },
      { readAt: daysAgo(200), createdAt: undefined },
      { readAt: 12345, createdAt: daysAgo(200) },
      { readAt: undefined, createdAt: daysAgo(200) },
    ]) {
      expect(isPrunableNotification({ id: 1, ...row }, cutoff), JSON.stringify(row)).toBe(false);
    }
  });

  it("accepts Date values as well as ISO strings", () => {
    const row = { id: 1, readAt: new Date(daysAgo(100)), createdAt: new Date(daysAgo(100)) };
    expect(isPrunableNotification(row, cutoff)).toBe(true);
  });
});

describe("prunableNotificationWhere", () => {
  it("selects in the database exactly what the rule prunes", async () => {
    const strapi = stub();
    const rows = await strapi.db
      .query(NOTIFICATION)
      .findMany({ where: prunableNotificationWhere(notificationPruneCutoff(NOW)) });
    const labels = Object.keys(ROWS);
    expect(rows.map((row) => labels[row.id - 1])).toEqual(PRUNABLE);
  });
});

describe("pruneNotifications", () => {
  it("deletes the prunable rows and keeps unread, recent and anchored ones", async () => {
    const strapi = stub();
    await expect(pruneNotifications(strapi as NotificationJanitorStrapi, NOW)).resolves.toBe(2);
    expect(labelsLeft(strapi)).toEqual(
      Object.keys(ROWS).filter((label) => !PRUNABLE.includes(label)),
    );
  });

  it("logs one line when it deleted something, none on a quiet night", async () => {
    const strapi = stub();
    await pruneNotifications(strapi as NotificationJanitorStrapi, NOW);
    expect(strapi.log.info.mock.calls).toEqual([
      [
        "[notification-janitor] pruned 2 read notification(s) read more than 90 days ago " +
          "(fan-out anchors and unread rows are kept)",
      ],
    ]);
    strapi.log.info.mockClear();
    await expect(pruneNotifications(strapi as NotificationJanitorStrapi, NOW)).resolves.toBe(0);
    expect(strapi.log.info).not.toHaveBeenCalled();
  });

  it("walks the rows in id pages and deletes page by page", async () => {
    const total = NOTIFICATION_PRUNE_BATCH * 2 + 7;
    const rows = Array.from({ length: total }, (_, i) =>
      i % 3 === 0 ? ROWS.unreadAncient : ROWS.readLongAgo,
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
      const ids = (call.params as { where: { id: { $in: number[] } } }).where.id.$in;
      expect(ids.length).toBeLessThanOrEqual(NOTIFICATION_PRUNE_BATCH);
    }
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
          deleteMany: async ({ where }: Record<string, unknown>) => ({
            count: (where as { id: { $in: number[] } }).id.$in.length,
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
            { id: 3, ...ROWS.unreadAncient },
          ],
          deleteMany: async ({ where }: Record<string, unknown>) => {
            const ids = (where as { id: { $in: number[] } }).id.$in;
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
