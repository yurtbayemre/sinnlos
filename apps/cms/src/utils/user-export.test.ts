import { describe, expect, it } from "vitest";

import { EXPORT_MAX_ROWS, exportUser, type ExportHost } from "./user-export";

/**
 * v0.31 (#168): the files and the duty plans are read whole, page by page;
 * only the person's rows are held and counted against EXPORT_MAX_ROWS. The
 * stub answers the whole-source reads (`where: {}`) in id pages like `walk`
 * asks for them (`id > afterId`, `limit`); every other read is empty (the
 * duty plan is also a CONTENT_RELATIONS source, read by its relation).
 */

type Row = Record<string, unknown>;
type Pages = (afterId: number, limit: number) => Row[];

const ME = 7;
const OTHER = 99;

function host(sources: Record<string, Pages>): ExportHost {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async () =>
          uid === "plugin::users-permissions.user" ? { id: ME, documentId: "me" } : null,
        findMany: async (params: Row) => {
          const [where, cursor] = (params.where as { $and: Row[] }).$and;
          const source = sources[uid];
          if (!source || Object.keys(where).length > 0) return [];
          return source((cursor.id as { $gt: number }).$gt, params.limit as number);
        },
        create: async () => ({}),
      }),
    },
  } as unknown as ExportHost;
}

/** Rows with the ids 1..total, made by `row`, one page at a time. */
const rows =
  (total: number, row: (id: number) => Row): Pages =>
  (afterId, limit) => {
    const out: Row[] = [];
    for (let id = afterId + 1; id <= total && out.length < limit; id++) out.push(row(id));
    return out;
  };

const file = (owner: (id: number) => number) => (id: number) => ({
  id,
  name: `file-${id}`,
  mime: "image/png",
  size: 1,
  createdAt: "2026-10-01T08:00:00.000Z",
  provider_metadata: { uploadedBy: owner(id) },
});

describe("the data export of files and duty plans (v0.31, #168)", () => {
  it("holds the person's files after more than EXPORT_MAX_ROWS unrelated ones", async () => {
    const unrelated = EXPORT_MAX_ROWS + 1;
    const strapi = host({
      "plugin::upload.file": rows(
        unrelated + 2,
        file((id) => (id > unrelated ? ME : OTHER)),
      ),
    });
    const out = await exportUser(strapi, ME, 1, null);
    expect((out.content.uploads as Row[]).map((f) => f.id)).toEqual([unrelated + 1, unrelated + 2]);
  });

  it("fails rather than cuts when the person has more than EXPORT_MAX_ROWS files", async () => {
    const strapi = host({
      "plugin::upload.file": rows(
        EXPORT_MAX_ROWS + 1,
        file(() => ME),
      ),
    });
    await expect(exportUser(strapi, ME, 1, null)).rejects.toThrow(
      `exceeds ${EXPORT_MAX_ROWS} rows`,
    );
  });

  it("exports only the person's shifts, after more than EXPORT_MAX_ROWS unrelated plans", async () => {
    const unrelated = EXPORT_MAX_ROWS + 1;
    const shift = (userId: number, day: string) => ({
      userId,
      startsAt: `${day}T06:00:00.000Z`,
      endsAt: `${day}T14:00:00.000Z`,
    });
    const strapi = host({
      "api::duty-plan.duty-plan": rows(unrelated + 1, (id) => ({
        id,
        documentId: `plan-${id}`,
        name: `Plan ${id}`,
        publishedAt: null,
        shifts:
          id > unrelated
            ? [shift(OTHER, "2026-10-01"), shift(ME, "2026-10-02")]
            : [shift(OTHER, "2026-10-01")],
      })),
    });
    const out = await exportUser(strapi, ME, 1, null);
    expect(out.content.dutyShifts).toEqual([
      {
        plan: {
          documentId: `plan-${unrelated + 1}`,
          name: `Plan ${unrelated + 1}`,
          publishedAt: null,
        },
        startsAt: "2026-10-02T06:00:00.000Z",
        endsAt: "2026-10-02T14:00:00.000Z",
      },
    ]);
  });
});
