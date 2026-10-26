import { describe, expect, it } from "vitest";

import { createStrapiStub } from "../test/strapi-stub.test.helper";
import { withNarrowing } from "../test/narrowing.test.helper";
import { findAllPaged, LOADER_PAGE } from "./paged-read";
import { departmentScopedIds } from "./policy-factories";
import { visibleTargetAnchors } from "./target-visibility";
import { visibleAnnouncementIds } from "./visible-ids";

/**
 * The paged visibility loaders (#175, v0.33): a populate binds one page of
 * parent ids, never the whole type. Each page is its own statement (mixed
 * time, utils/paged-read.ts), so a write between pages may show on one page
 * and not another; the announcement loaders re-read their fail-closed
 * markers once after the last page.
 */

const DOCUMENT = "api::document.document";
const ANNOUNCEMENT = "api::announcement.announcement";

interface Call {
  where?: unknown;
  orderBy?: unknown;
  limit?: number;
  populate?: unknown;
}

describe("findAllPaged", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ id: (index + 1) * 10 }));
  const query = (calls: Call[]) => ({
    findMany: async (params: Call) => {
      calls.push(params);
      const where = params.where as { $and?: { id?: { $gt: number } }[]; id?: { $gt: number } };
      const after = where.$and?.[1]?.id?.$gt ?? where.id?.$gt ?? 0;
      return rows.filter((row) => row.id > after).slice(0, params.limit);
    },
  });

  it("reads every row by an ascending id cursor, its where ANDed with the cursor", async () => {
    const calls: Call[] = [];
    const read = await findAllPaged(query(calls), { where: { a: 1 }, select: ["id"] }, 5);
    expect(read).toEqual(rows);
    expect(calls.map((call) => call.where)).toEqual([
      { $and: [{ a: 1 }, { id: { $gt: 0 } }] },
      { $and: [{ a: 1 }, { id: { $gt: 50 } }] },
      { $and: [{ a: 1 }, { id: { $gt: 100 } }] },
    ]);
    expect(calls.every((call) => call.limit === 5)).toBe(true);
    expect(calls.every((call) => JSON.stringify(call.orderBy) === '[{"id":"asc"}]')).toBe(true);
  });

  it("asks once more after a full last page, and stops on an empty one", async () => {
    const calls: Call[] = [];
    await expect(findAllPaged(query(calls), { select: ["id"] }, 6)).resolves.toEqual(rows);
    expect(calls.map((call) => call.where)).toEqual([
      { id: { $gt: 0 } },
      { id: { $gt: 60 } },
      { id: { $gt: 120 } },
    ]);
  });

  it("refuses a page that does not move the cursor (no endless loop)", async () => {
    const stuck = { findMany: async () => [{ id: 5 }, { id: 5 }] };
    await expect(findAllPaged(stuck, { select: ["id"] }, 2)).rejects.toThrow(
      "did not advance past id 5",
    );
  });
});

describe("paged loaders: a write between pages (mixed time)", () => {
  // One row more than a page, plus a few: two pages of LOADER_PAGE.
  const COUNT = LOADER_PAGE + 4;
  const LATE = LOADER_PAGE + 2;

  /** Every document company-wide except row LATE (Sales-only). */
  function stub() {
    const strapi = createStrapiStub({
      tables: {
        "plugin::users-permissions.user": [{ id: 1, username: "eng", department: { id: 10 } }],
        [DOCUMENT]: Array.from({ length: COUNT }, (_, index) => ({
          id: index + 1,
          title: `d${index + 1}`,
          audience: index + 1 === LATE ? "departments" : "all",
          departments: index + 1 === LATE ? [{ id: 11 }] : [],
        })),
      },
    });
    return withNarrowing(strapi, { state: {} });
  }

  it("shows each row in one of its committed states, never a row hidden in both", async () => {
    const strapi = stub();
    const query = strapi.db.query.bind(strapi.db);
    let pages = 0;
    strapi.db.query = (uid: string) => {
      const inner = query(uid);
      if (uid !== DOCUMENT) return inner;
      return {
        ...inner,
        findMany: async (params) => {
          const page = await inner.findMany(params);
          pages += 1;
          if (pages === 1) {
            // Committed between the pages: row 2 (already read) turns
            // Sales-only, row LATE (not read yet) turns company-wide.
            const table = strapi.tables[DOCUMENT];
            Object.assign(table[1], { audience: "departments", departments: [{ id: 11 }] });
            Object.assign(table[LATE - 1], { audience: "all", departments: [] });
          }
          return page;
        },
      };
    };
    const ids = await departmentScopedIds({
      strapi,
      user: { id: 1 },
      config: undefined,
      uid: DOCUMENT,
    });
    expect(pages).toBe(2);
    // Row 2 as read on page 1 (before the write), row LATE as read on page 2
    // (after it): each in a state that was committed when its page ran.
    expect(ids).toHaveLength(COUNT);
    expect(ids).toContain(2);
    expect(ids).toContain(LATE);
  });
});

describe("announcement loaders: a retarget marker set after the first page", () => {
  const PUBLISHED = "2026-09-01T00:00:00.000Z";
  const COUNT = LOADER_PAGE + 2;
  const anchor = (id: number) => `ann${String(id).padStart(21, "0")}`;

  function stub() {
    return withNarrowing(
      createStrapiStub({
        tables: {
          "plugin::users-permissions.user": [{ id: 1, username: "eng", department: { id: 10 } }],
          [ANNOUNCEMENT]: Array.from({ length: COUNT }, (_, index) => ({
            id: index + 1,
            documentId: anchor(index + 1),
            title: `a${index + 1}`,
            audience: "all",
            publishedAt: PUBLISHED,
          })),
        },
      }),
      { state: {} },
    );
  }

  /** After the first populated page, a department delete marks announcement 1. */
  function markAfterFirstPage(strapi: ReturnType<typeof stub>) {
    const query = strapi.db.query.bind(strapi.db);
    let pages = 0;
    strapi.db.query = (uid: string) => {
      const inner = query(uid);
      if (uid !== ANNOUNCEMENT) return inner;
      return {
        ...inner,
        findMany: async (params) => {
          const page = await inner.findMany(params);
          if (params?.populate) {
            pages += 1;
            if (pages === 1) strapi.tables[ANNOUNCEMENT][0].retargetRequired = true;
          }
          return page;
        },
      };
    };
    return () => pages;
  }

  it("keeps the marked announcement out of the policy's list (one final flag re-read)", async () => {
    const strapi = stub();
    const pages = markAfterFirstPage(strapi);
    const ids = await visibleAnnouncementIds({
      strapi,
      user: { id: 1 },
      config: undefined,
      uid: ANNOUNCEMENT,
    });
    expect(pages()).toBe(2);
    expect(ids).toHaveLength(COUNT - 1);
    expect(ids).not.toContain(1);
  });

  it("keeps it out of the comment targets too", async () => {
    const strapi = stub();
    const pages = markAfterFirstPage(strapi);
    const anchors = await visibleTargetAnchors(strapi, { id: 1, role: { type: "member" } });
    expect(pages()).toBe(2);
    expect(anchors.announcement).toHaveLength(COUNT - 1);
    expect(anchors.announcement).not.toContain(anchor(1));
  });
});
