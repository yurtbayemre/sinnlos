import { afterEach, describe, expect, it, vi } from "vitest";

import { createStrapiStub, type Row } from "../test/strapi-stub.test.helper";
import { parsePlainDate } from "../utils/time";
import {
  CLASSIFIED_PURGE_BATCH,
  CLASSIFIED_PURGE_DAYS,
  CLASSIFIED_PURGE_MAX_PER_RUN,
  classifiedPurgeCutoff,
  isPurgeableClassified,
  purgeExpiredClassifieds,
  type ClassifiedJanitorStrapi,
} from "./purge-expired-classifieds";

/**
 * LF07 marketplace retention (owner default 2026-09-29 (b)): an ad is
 * purged, images included, once its last listed day (`expiresAt`, a
 * calendar date) lies more than 90 days before today in APP_TIME_ZONE.
 * Every purge goes through the Document Service, so the classified delete
 * lifecycles remove the images (the image cleanup itself is pinned in
 * api/classified/content-types/classified/lifecycles*.test.ts, the chain
 * on both engines in integration/retention.integration.test.ts).
 */

const CLASSIFIED = "api::classified.classified";
const TODAY = parsePlainDate("2026-09-29");

/** 90 days before 2026-09-29. */
const CUTOFF = "2026-07-01";

function janitor(rows: Array<Omit<Row, "id">>, failFor: string[] = []) {
  const stub = createStrapiStub({
    tables: {
      [CLASSIFIED]: rows.map((row, index) => ({
        id: index + 1,
        documentId: `ad${String(index + 1).padStart(22, "0")}`,
        title: `ad ${index + 1}`,
        ...row,
      })),
    },
  });
  const deleted: string[] = [];
  const remove = vi.fn(async ({ documentId }: { documentId: string }) => {
    if (failFor.includes(documentId)) throw new Error("deadlock detected");
    deleted.push(documentId);
    stub.tables[CLASSIFIED] = stub.tables[CLASSIFIED].filter(
      (row) => row.documentId !== documentId,
    );
    return { documentId };
  });
  const documents = vi.fn((_uid: string) => ({ delete: remove }));
  const strapi: ClassifiedJanitorStrapi = { db: stub.db, documents, log: stub.log };
  return { strapi, stub, deleted, documents, remove };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("classifiedPurgeCutoff", () => {
  it("is 90 calendar days before today", () => {
    expect(CLASSIFIED_PURGE_DAYS).toBe(90);
    expect(classifiedPurgeCutoff(TODAY).toString()).toBe(CUTOFF);
    // Calendar arithmetic: a leap day and month ends do not shift it.
    expect(classifiedPurgeCutoff(parsePlainDate("2028-05-29")).toString()).toBe("2028-02-29");
  });
});

describe("isPurgeableClassified (pure)", () => {
  const cutoff = classifiedPurgeCutoff(TODAY);
  const ad = (expiresAt: unknown, documentId: unknown = "ad1") => ({
    id: 1,
    documentId,
    expiresAt,
  });

  it("purges an expiry strictly before the cutoff", () => {
    expect(isPurgeableClassified(ad("2026-06-30"), cutoff)).toBe(true);
    expect(isPurgeableClassified(ad("2020-01-01"), cutoff)).toBe(true);
    expect(isPurgeableClassified(ad(CUTOFF), cutoff)).toBe(false);
    expect(isPurgeableClassified(ad("2026-09-28"), cutoff)).toBe(false);
    expect(isPurgeableClassified(ad("2026-12-31"), cutoff)).toBe(false);
  });

  it("keeps what it cannot read: no date, no documentId, a Date object, garbage", () => {
    for (const row of [
      ad(null),
      ad(undefined),
      ad("2026-02-30"),
      ad("30.06.2026"),
      ad(new Date("2020-01-01T00:00:00Z")),
      ad("2020-01-01", null),
      ad("2020-01-01", ""),
    ]) {
      expect(isPurgeableClassified(row, cutoff), String(row.expiresAt)).toBe(false);
    }
  });
});

describe("purgeExpiredClassifieds", () => {
  it("deletes only the long-expired ads, one by one through the Document Service", async () => {
    const { strapi, deleted, documents, stub } = janitor([
      { expiresAt: "2026-06-30" },
      { expiresAt: CUTOFF },
      { expiresAt: "2026-09-29" },
      { expiresAt: "2025-01-15" },
      { expiresAt: "2026-10-20" },
    ]);
    await expect(purgeExpiredClassifieds(strapi, TODAY)).resolves.toBe(2);
    expect(deleted).toEqual([`ad${"1".padStart(22, "0")}`, `ad${"4".padStart(22, "0")}`]);
    expect(documents.mock.calls.every(([uid]) => uid === CLASSIFIED)).toBe(true);
    expect(stub.tables[CLASSIFIED].map((row) => row.expiresAt)).toEqual([
      CUTOFF,
      "2026-09-29",
      "2026-10-20",
    ]);
    // The read already narrows by date; nothing is deleted with deleteMany.
    expect(stub.calls.some((call) => call.method.startsWith("delete"))).toBe(false);
    expect(stub.log.info.mock.calls).toEqual([
      [
        "[classified-janitor] purged 2 ad(s) expired before 2026-07-01 (90 days after their last day)",
      ],
    ]);
  });

  it("skips an ad whose delete fails, logs it and purges the rest", async () => {
    const failing = `ad${"1".padStart(22, "0")}`;
    const { strapi, deleted, stub } = janitor(
      [{ expiresAt: "2026-01-01" }, { expiresAt: "2026-01-02" }],
      [failing],
    );
    await expect(purgeExpiredClassifieds(strapi, TODAY)).resolves.toBe(1);
    expect(deleted).toEqual([`ad${"2".padStart(22, "0")}`]);
    expect(stub.log.warn.mock.calls).toEqual([
      ["[classified-janitor] ad 1 could not be deleted: deadlock detected"],
    ]);
    expect(stub.log.info.mock.calls[0][0]).toContain("1 failed and stay for the next night");
  });

  it("stays silent on a night without expired ads", async () => {
    const { strapi, stub } = janitor([{ expiresAt: "2026-09-30" }]);
    await expect(purgeExpiredClassifieds(strapi, TODAY)).resolves.toBe(0);
    expect(stub.log.info).not.toHaveBeenCalled();
  });

  it("walks the ads in id pages and stops at CLASSIFIED_PURGE_MAX_PER_RUN", async () => {
    const rows = Array.from({ length: CLASSIFIED_PURGE_MAX_PER_RUN + 5 }, () => ({
      expiresAt: "2025-01-01",
    }));
    const { strapi, stub } = janitor(rows);
    await expect(purgeExpiredClassifieds(strapi, TODAY)).resolves.toBe(
      CLASSIFIED_PURGE_MAX_PER_RUN,
    );
    expect(stub.tables[CLASSIFIED]).toHaveLength(5);
    const reads = stub.calls.filter((call) => call.method === "findMany");
    for (const call of reads) {
      expect((call.params as { limit: number }).limit).toBeLessThanOrEqual(CLASSIFIED_PURGE_BATCH);
    }
  });

  it("reads today in APP_TIME_ZONE when no date is passed", async () => {
    const previous = process.env.APP_TIME_ZONE;
    vi.useFakeTimers({ toFake: ["Date"] });
    // 22:30 UTC on 2026-09-29 is already 2026-09-30 in Berlin: the cutoff
    // moves to 2026-07-02, so an ad whose last day was 2026-07-01 goes.
    vi.setSystemTime(new Date("2026-09-29T22:30:00.000Z"));
    try {
      process.env.APP_TIME_ZONE = "Europe/Berlin";
      const berlin = janitor([{ expiresAt: CUTOFF }]);
      await expect(purgeExpiredClassifieds(berlin.strapi)).resolves.toBe(1);
      process.env.APP_TIME_ZONE = "UTC";
      const utc = janitor([{ expiresAt: CUTOFF }]);
      await expect(purgeExpiredClassifieds(utc.strapi)).resolves.toBe(0);
    } finally {
      if (previous === undefined) delete process.env.APP_TIME_ZONE;
      else process.env.APP_TIME_ZONE = previous;
    }
  });
});
