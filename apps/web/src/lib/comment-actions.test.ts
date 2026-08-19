import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getCommentSection` fetches a deliberate NEWEST-first window instead of a
 * page walk (issue #26): the section is re-fetched on a poll interval, so a
 * full walk would multiply requests. The old `sort=createdAt:asc` cut off
 * the NEWEST comments once a thread passed the 100-row window — these tests
 * pin the flipped fetch direction AND that the user-visible display order
 * (oldest first) stayed exactly as before.
 *
 * `@/lib/strapi` and `@/auth` are mocked wholesale — the real modules pull
 * in next/auth; only the URL contract and the row post-processing matter
 * here. `next/navigation` is stubbed for the same reason (the error
 * fallbacks import `unstable_rethrow`).
 */
const strapiMock = vi.fn();
vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: 7 } }) }));
vi.mock("next/navigation", () => ({ unstable_rethrow: () => {} }));

const { getCommentSection } = await import("./comment-actions");

/** The section under test — anchored by documentId (issue #11). */
const target = { type: "announcement", documentId: "doc-a" } as const;

/** A comment row that belongs to `target` (matchesTarget re-checks it). */
const comment = (id: number, createdAt: string) => ({
  id,
  body: `comment ${id}`,
  createdAt,
  targetType: "announcement",
  targetDocumentId: "doc-a",
});

const urls = () => strapiMock.mock.calls.map((c) => String(c[0]));
const urlFor = (path: string) => urls().find((u) => u.startsWith(path)) ?? "";

beforeEach(() => {
  strapiMock.mockReset();
  strapiMock.mockResolvedValue({ data: [] });
});

describe("getCommentSection", () => {
  it("fetches comments NEWEST-first so a hot thread never loses the latest entries", async () => {
    await getCommentSection(target);
    const commentsUrl = urlFor("/api/comments");
    expect(commentsUrl).toContain("sort[0]=createdAt:desc");
    // Secondary sort disambiguates rows sharing a createdAt.
    expect(commentsUrl).toContain("sort[1]=id:desc");
    expect(commentsUrl).toContain("pagination[pageSize]=100");
    expect(commentsUrl).not.toContain("createdAt:asc");
  });

  it("renders the window in ascending order (oldest first), as before the flip", async () => {
    // Server answers the desc fetch: newest row first.
    strapiMock.mockImplementation(async (url: string) =>
      url.startsWith("/api/comments")
        ? {
            data: [
              comment(3, "2026-08-19T10:00:00.000Z"),
              comment(2, "2026-08-19T09:00:00.000Z"),
              comment(1, "2026-08-19T08:00:00.000Z"),
            ],
          }
        : { data: [] },
    );
    const { comments } = await getCommentSection(target);
    expect(comments.map((c) => c.id)).toEqual([1, 2, 3]);
  });

  it("drops rows of a foreign discussion before reversing", async () => {
    strapiMock.mockImplementation(async (url: string) =>
      url.startsWith("/api/comments")
        ? {
            data: [
              comment(2, "2026-08-19T09:00:00.000Z"),
              { ...comment(99, "2026-08-19T08:30:00.000Z"), targetDocumentId: "doc-OTHER" },
              comment(1, "2026-08-19T08:00:00.000Z"),
            ],
          }
        : { data: [] },
    );
    const { comments } = await getCommentSection(target);
    expect(comments.map((c) => c.id)).toEqual([1, 2]);
  });

  it("fetches the reaction window with a deterministic newest-first sort", async () => {
    await getCommentSection(target);
    const reactionsUrl = urlFor("/api/reactions");
    // Without an explicit sort Postgres returns rows in arbitrary order and
    // the 500-row window was nondeterministic.
    expect(reactionsUrl).toContain("sort[0]=createdAt:desc");
    expect(reactionsUrl).toContain("sort[1]=id:desc");
    expect(reactionsUrl).toContain("pagination[pageSize]=500");
  });

  it("renders an empty section when the target has no usable anchor", async () => {
    const result = await getCommentSection({ type: "announcement" });
    expect(result.comments).toEqual([]);
    expect(strapiMock).not.toHaveBeenCalled();
  });
});
