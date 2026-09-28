import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The lesson-progress page walks (WD02): both are sorted by id, so a walk
 * over several pages neither skips nor repeats rows on Postgres (no ORDER
 * BY means no stable order between pages), and "first row wins" in
 * fetchMyProgress means the oldest receipt. The transport
 * (`@/lib/strapi/client`, WD01) is mocked; the requests
 * (lib/api/training.ts) and the page walk (lib/paginate.ts) are the real
 * ones.
 */

const strapiMock = vi.fn();
vi.mock("@/lib/strapi/client", () => ({
  strapi: (...args: unknown[]) => strapiMock(...args),
}));

const { fetchCourseProgress, fetchMyProgress } = await import("./training");

const page = (data: unknown[], pageNo: number, pageCount: number) => ({
  data,
  meta: { pagination: { page: pageNo, pageSize: 100, pageCount, total: data.length } },
});

beforeEach(() => {
  strapiMock.mockReset();
});

describe("fetchCourseProgress", () => {
  it("walks every page of the course's lessons, sorted by id, user ids only", async () => {
    strapiMock
      .mockResolvedValueOnce(page([{ id: 1, targetDocumentId: "a", user: { id: 5 } }], 1, 2))
      .mockResolvedValueOnce(page([{ id: 2, targetDocumentId: "b", user: { id: 5 } }], 2, 2));
    const result = await fetchCourseProgress(["a", "b c"], "training-report:x");
    expect(result).toEqual({
      data: [
        { id: 1, targetDocumentId: "a", user: { id: 5 } },
        { id: 2, targetDocumentId: "b", user: { id: 5 } },
      ],
      truncated: false,
    });
    expect(strapiMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/lesson-progresses?filters[targetDocumentId][$in][0]=a&filters[targetDocumentId][$in][1]=b%20c&fields[0]=targetDocumentId&populate[user][fields][0]=id&sort[0]=id:asc&pagination[page]=1&pagination[pageSize]=100",
      "/api/lesson-progresses?filters[targetDocumentId][$in][0]=a&filters[targetDocumentId][$in][1]=b%20c&fields[0]=targetDocumentId&populate[user][fields][0]=id&sort[0]=id:asc&pagination[page]=2&pagination[pageSize]=100",
    ]);
  });
});

describe("fetchMyProgress", () => {
  it("reads the caller's receipts sorted by id and keeps the oldest per lesson", async () => {
    strapiMock.mockResolvedValueOnce(
      page(
        [
          { id: 1, targetDocumentId: "a", completedAt: "2026-09-01T10:00:00.000Z" },
          { id: 2, targetDocumentId: "a", completedAt: "2026-09-02T10:00:00.000Z" },
          { id: 3, targetDocumentId: "b", completedAt: null },
        ],
        1,
        1,
      ),
    );
    const { completed, truncated } = await fetchMyProgress();
    expect(truncated).toBe(false);
    expect([...completed]).toEqual([
      ["a", "2026-09-01T10:00:00.000Z"],
      ["b", null],
    ]);
    expect(strapiMock.mock.calls[0]).toEqual([
      "/api/lesson-progresses?fields[0]=targetDocumentId&fields[1]=completedAt&sort[0]=id:asc&pagination[page]=1&pagination[pageSize]=100",
    ]);
  });
});
