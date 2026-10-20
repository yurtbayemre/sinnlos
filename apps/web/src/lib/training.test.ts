import { StrapiError } from "@/lib/strapi-error";
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

const { fetchMyProgress, fetchLessonByDocumentId } = await import("./training");

const page = (data: unknown[], pageNo: number, pageCount: number) => ({
  data,
  meta: { pagination: { page: pageNo, pageSize: 100, pageCount, total: data.length } },
});

beforeEach(() => {
  strapiMock.mockReset();
});

describe("fetchMyProgress", () => {
  it("reads the caller's receipts sorted by id and keeps the newest per lesson", async () => {
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
    // A renewed lesson (v0.20) has several receipts: the newest counts.
    expect([...completed]).toEqual([
      ["a", "2026-09-02T10:00:00.000Z"],
      ["b", null],
    ]);
    expect(strapiMock.mock.calls[0]).toEqual([
      "/api/lesson-progresses?fields[0]=targetDocumentId&fields[1]=completedAt&sort[0]=id:asc&pagination[page]=1&pagination[pageSize]=100",
    ]);
  });
});

describe("fetchLessonByDocumentId", () => {
  it("uses the fixed player route and preserves answerless questions", async () => {
    const data = {
      documentId: "lesson",
      quiz: [{ question: "Q", options: ["A", "B"] }],
      course: { completionMode: "exam" },
    };
    strapiMock.mockResolvedValue({ data });
    await expect(fetchLessonByDocumentId("lesson/id")).resolves.toEqual(data);
    expect(strapiMock).toHaveBeenCalledExactlyOnceWith("/api/lessons/lesson%2Fid/player");
  });

  it("maps an unavailable player to missing, preserving transport and permission failures", async () => {
    strapiMock.mockRejectedValue(new StrapiError(404, "Not Found", ""));
    await expect(fetchLessonByDocumentId("missing")).resolves.toBeNull();
    for (const status of [403, 500]) {
      const error = new StrapiError(status, "Error", "");
      strapiMock.mockRejectedValue(error);
      await expect(fetchLessonByDocumentId("lesson")).rejects.toBe(error);
    }
  });
});
