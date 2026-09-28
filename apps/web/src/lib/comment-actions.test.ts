import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactionIntent } from "@/lib/optimistic";
import type { EmojiType } from "@/lib/types";

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
/** The signed-in caller (user 7); a test may sign out by setting `user` to null. */
const session = vi.hoisted(() => ({ user: { id: 7 } as { id: number } | null }));
vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("@/auth", () => ({ auth: async () => (session.user ? { user: session.user } : null) }));
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
  session.user = { id: 7 };
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

/**
 * The caller's own reaction may be older than the newest-500 window
 * (1B-T1). The bar sends the negation of `reacted` as the desired state
 * (FX28), and the CMS answers `reacted: true` on an existing row with a
 * no-op, so a missed own row could never be removed. When
 * `meta.pagination.total` says the window overflowed, the caller's rows of
 * the target are read on their own.
 */
describe("getCommentSection: own reaction outside the reaction window", () => {
  const reactionRow = (id: number, emoji: EmojiType, authorId: number, doc = "doc-a") => ({
    id,
    emoji,
    targetType: "announcement",
    targetDocumentId: doc,
    author: { id: authorId, displayName: `user ${authorId}` },
  });
  /** 500 foreign thumbsup rows: the window is full. */
  const foreignWindow = Array.from({ length: 500 }, (_, i) => reactionRow(1000 - i, "thumbsup", 9));
  const isOwnLookup = (url: string) => url.includes("filters[author][id][$eq]=");

  /** Answers the window with `total` and the own lookup with `own`. */
  function serve(total: number, own: () => Promise<unknown>) {
    strapiMock.mockImplementation(async (url: string) => {
      if (!url.startsWith("/api/reactions")) return { data: [] };
      if (isOwnLookup(url)) return own();
      return {
        data: foreignWindow,
        meta: { pagination: { page: 1, pageSize: 500, pageCount: 2, total } },
      };
    });
  }

  it("shows an own reaction the window missed as pressed, so the next click removes it", async () => {
    serve(501, async () => ({ data: [reactionRow(1, "heart", 7)] }));
    const { reactions } = await getCommentSection(target);
    const heart = reactions.find((r) => r.emoji === "heart");
    // Not in the window, so not counted there either: the count grows by one.
    expect(heart).toEqual({ emoji: "heart", count: 1, reacted: true });
    expect(reactions.find((r) => r.emoji === "thumbsup")).toEqual({
      emoji: "thumbsup",
      count: 500,
      reacted: false,
    });
    expect(reactionIntent(reactions, "heart")).toEqual({ emoji: "heart", reacted: false });
  });

  it("reads only the caller's rows of this target", async () => {
    serve(501, async () => ({ data: [] }));
    await getCommentSection(target);
    const own = urls().filter(isOwnLookup);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatch(/^\/api\/reactions\?/);
    expect(own[0]).toContain("filters[targetType][$eq]=announcement");
    expect(own[0]).toContain("filters[targetDocumentId][$eq]=doc-a");
    expect(own[0]).toContain("filters[author][id][$eq]=7");
    expect(own[0]).toContain("populate[author]=true");
  });

  it("sends no extra request when the window holds every row", async () => {
    serve(500, async () => ({ data: [reactionRow(1, "heart", 7)] }));
    const { reactions } = await getCommentSection(target);
    expect(urls().filter(isOwnLookup)).toEqual([]);
    expect(strapiMock).toHaveBeenCalledTimes(2);
    expect(reactions.find((r) => r.emoji === "heart")?.reacted).toBe(false);
  });

  it("sends no extra request without meta (older answer shape, demo, failed read)", async () => {
    strapiMock.mockResolvedValue({ data: [] });
    await getCommentSection(target);
    expect(strapiMock).toHaveBeenCalledTimes(2);
  });

  it("re-checks target and author of the own rows", async () => {
    serve(501, async () => ({
      data: [reactionRow(2, "heart", 7, "doc-OTHER"), reactionRow(3, "laugh", 8)],
    }));
    const { reactions } = await getCommentSection(target);
    expect(reactions.filter((r) => r.reacted)).toEqual([]);
    expect(reactions.find((r) => r.emoji === "heart")?.count).toBe(0);
    expect(reactions.find((r) => r.emoji === "laugh")?.count).toBe(0);
  });

  it("keeps the window's answer when the own lookup fails", async () => {
    serve(501, async () => {
      throw new Error("down");
    });
    const { reactions } = await getCommentSection(target);
    expect(reactions.find((r) => r.emoji === "thumbsup")?.count).toBe(500);
    expect(reactions.filter((r) => r.reacted)).toEqual([]);
  });

  it("skips the lookup without a signed-in user", async () => {
    session.user = null;
    serve(501, async () => ({ data: [reactionRow(1, "heart", 7)] }));
    const { reactions } = await getCommentSection(target);
    expect(urls().filter(isOwnLookup)).toEqual([]);
    expect(reactions.filter((r) => r.reacted)).toEqual([]);
  });
});
