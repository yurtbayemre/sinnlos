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

const { getCommentSection, getCommentSections } = await import("./comment-actions");

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

/**
 * WD04: getCommentSections loads a page's sections together: ONE reactions
 * request per 50 targets (`$in`), plus each target's newest-100 comment
 * window, with the matchesTarget re-check per row and per target. Each
 * section equals what the single-target read gives it.
 */
describe("getCommentSections (batched, WD04)", () => {
  const t = (doc: string) => ({ type: "announcement", documentId: doc }) as const;
  const reaction = (id: number, doc: string, emoji: EmojiType, authorId: number) => ({
    id,
    emoji,
    targetType: "announcement",
    targetDocumentId: doc,
    author: { id: authorId, displayName: `user ${authorId}` },
  });
  const commentOf = (id: number, doc: string) => ({
    ...comment(id, "2026-08-19T08:00:00.000Z"),
    targetDocumentId: doc,
  });
  const reactionUrls = () => urls().filter((u) => u.startsWith("/api/reactions"));
  const commentUrls = () => urls().filter((u) => u.startsWith("/api/comments"));
  type Targets = Parameters<typeof getCommentSections>[0];

  it("sends one reactions request with $in for every target and one comment window per target", async () => {
    await getCommentSections([t("doc-a"), t("doc-b"), t("doc-c")]);
    expect(reactionUrls()).toHaveLength(1);
    const [reactions] = reactionUrls();
    expect(reactions).toContain("filters[targetType][$in][0]=announcement");
    expect(reactions).toContain("filters[targetDocumentId][$in][0]=doc-a");
    expect(reactions).toContain("filters[targetDocumentId][$in][1]=doc-b");
    expect(reactions).toContain("filters[targetDocumentId][$in][2]=doc-c");
    expect(reactions).toContain("sort[0]=createdAt:desc&sort[1]=id:desc");
    // Room for the newest 500 rows of each target.
    expect(reactions).toContain("pagination[pageSize]=1500");
    expect(commentUrls()).toHaveLength(3);
    for (const [i, doc] of ["doc-a", "doc-b", "doc-c"].entries()) {
      expect(commentUrls()[i]).toContain(`filters[targetDocumentId][$eq]=${doc}`);
      expect(commentUrls()[i]).toContain(
        "sort[0]=createdAt:desc&sort[1]=id:desc&pagination[pageSize]=100",
      );
    }
  });

  it("loads 10 cards with 11 requests (before WD04: 20, a comment and a reaction window per card)", async () => {
    await getCommentSections(Array.from({ length: 10 }, (_, i) => t(`doc-${i}`)));
    expect(strapiMock).toHaveBeenCalledTimes(11);
    expect(reactionUrls()).toHaveLength(1);
  });

  it("keeps a single target on the $eq pair (the cms policy's fast path)", async () => {
    await getCommentSections([t("doc-a")]);
    expect(reactionUrls()).toEqual([
      "/api/reactions?filters[targetType][$eq]=announcement&filters[targetDocumentId][$eq]=doc-a&populate[author]=true&sort[0]=createdAt:desc&sort[1]=id:desc&pagination[pageSize]=500",
    ]);
  });

  it("splits the reactions into one request per 50 targets", async () => {
    const targets = Array.from({ length: 120 }, (_, i) => t(`doc-${i}`));
    await getCommentSections(targets);
    expect(reactionUrls()).toHaveLength(3);
    expect(reactionUrls()[2]).toContain("filters[targetDocumentId][$in][19]=doc-119");
    expect(reactionUrls()[2]).not.toContain("[$in][20]=");
    expect(commentUrls()).toHaveLength(120);
  });

  it("gives each section its own rows, in the order asked, and drops foreign rows", async () => {
    strapiMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/comments")) {
        const doc = /targetDocumentId\]\[\$eq\]=([^&]+)/.exec(url)?.[1] ?? "";
        // The newest first; one foreign row slipped in.
        return { data: [commentOf(3, doc), commentOf(99, "doc-OTHER"), commentOf(1, doc)] };
      }
      return {
        data: [
          reaction(10, "doc-b", "heart", 7),
          reaction(9, "doc-a", "heart", 8),
          reaction(8, "doc-OTHER", "heart", 7),
          reaction(7, "doc-a", "laugh", 7),
          { ...reaction(6, "doc-a", "celebrate", 8), targetType: "wiki-page" },
        ],
        meta: { pagination: { total: 5 } },
      };
    });
    const [b, a, missing] = await getCommentSections([
      t("doc-b"),
      t("doc-a"),
      { type: "announcement" },
    ]);
    expect(b?.comments.map((c) => c.id)).toEqual([1, 3]);
    expect(a?.comments.map((c) => c.id)).toEqual([1, 3]);
    const counts = (section: typeof a) =>
      Object.fromEntries((section?.reactions ?? []).map((r) => [r.emoji, [r.count, r.reacted]]));
    expect(counts(b)).toMatchObject({ heart: [1, true], laugh: [0, false], celebrate: [0, false] });
    expect(counts(a)).toMatchObject({ heart: [1, false], laugh: [1, true], celebrate: [0, false] });
    // No anchor: an empty section, and no query for it.
    expect(missing?.comments).toEqual([]);
    expect(missing?.reactions.every((r) => r.count === 0)).toBe(true);
    expect(commentUrls()).toHaveLength(2);
  });

  it("reads a target named twice once and answers both entries", async () => {
    const sections = await getCommentSections([t("doc-a"), t("doc-a")]);
    expect(sections).toHaveLength(2);
    expect(commentUrls()).toHaveLength(1);
    expect(reactionUrls()[0]).toContain("filters[targetDocumentId][$eq]=doc-a");
  });

  it("counts the newest 500 rows per target and marks an older own row, without an extra request", async () => {
    const rowsA = Array.from({ length: 500 }, (_, i) => reaction(5000 - i, "doc-a", "thumbsup", 9));
    strapiMock.mockImplementation(async (url: string) =>
      url.startsWith("/api/reactions")
        ? {
            data: [...rowsA, reaction(1, "doc-a", "heart", 7), reaction(2, "doc-b", "laugh", 9)],
            meta: { pagination: { total: 502 } },
          }
        : { data: [] },
    );
    const [a, b] = await getCommentSections([t("doc-a"), t("doc-b")]);
    expect(a?.reactions.find((r) => r.emoji === "thumbsup")).toEqual({
      emoji: "thumbsup",
      count: 500,
      reacted: false,
    });
    // Past the window: not counted there, shown as pressed (count + 1).
    expect(a?.reactions.find((r) => r.emoji === "heart")).toEqual({
      emoji: "heart",
      count: 1,
      reacted: true,
    });
    expect(b?.reactions.find((r) => r.emoji === "laugh")?.count).toBe(1);
    expect(reactionUrls()).toHaveLength(1);
  });

  it("when the batch page overflows: the own lookup for a full window, a single read for the rest", async () => {
    const rowsA = Array.from({ length: 1000 }, (_, i) =>
      reaction(9000 - i, "doc-a", "thumbsup", 9),
    );
    strapiMock.mockImplementation(async (url: string) => {
      if (!url.startsWith("/api/reactions")) return { data: [] };
      if (url.includes("filters[author][id][$eq]=7")) {
        return { data: [reaction(3, "doc-a", "heart", 7)] };
      }
      if (url.includes("$in")) return { data: rowsA, meta: { pagination: { total: 1400 } } };
      // doc-b on its own: its newest-500 window.
      return { data: [reaction(4, "doc-b", "laugh", 9)], meta: { pagination: { total: 1 } } };
    });
    const [a, b] = await getCommentSections([t("doc-a"), t("doc-b")]);
    expect(a?.reactions.find((r) => r.emoji === "thumbsup")?.count).toBe(500);
    expect(a?.reactions.find((r) => r.emoji === "heart")).toEqual({
      emoji: "heart",
      count: 1,
      reacted: true,
    });
    expect(b?.reactions.find((r) => r.emoji === "laugh")?.count).toBe(1);
    const own = reactionUrls().filter((u) => u.includes("filters[author][id][$eq]="));
    expect(own).toHaveLength(1);
    expect(own[0]).toContain("filters[targetDocumentId][$eq]=doc-a");
    expect(
      reactionUrls().filter(
        (u) => u.includes("filters[targetDocumentId][$eq]=doc-b") && !u.includes("filters[author]"),
      ),
    ).toHaveLength(1);
  });

  it("reads at most 25 comment windows at a time", async () => {
    let open = 0;
    let maxOpen = 0;
    strapiMock.mockImplementation(async (url: string) => {
      if (!url.startsWith("/api/comments")) return { data: [] };
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      await new Promise((resolve) => setTimeout(resolve, 1));
      open -= 1;
      return { data: [] };
    });
    const sections = await getCommentSections(Array.from({ length: 60 }, (_, i) => t(`doc-${i}`)));
    expect(sections).toHaveLength(60);
    expect(commentUrls()).toHaveLength(60);
    expect(maxOpen).toBe(25);
  });

  it("refuses a list that is not an array or longer than 200 targets, before any read", async () => {
    const tooMany = Array.from({ length: 201 }, (_, i) => t(`doc-${i}`));
    await expect(getCommentSections(tooMany)).rejects.toThrow("invalid comment section targets");
    await expect(getCommentSections("doc-a" as unknown as Targets)).rejects.toThrow(
      "invalid comment section targets",
    );
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("gives an entry of an unknown type or shape an empty section without a query", async () => {
    const odd = [
      null,
      { type: "event", documentId: "doc-a" },
      { type: "announcement", documentId: " " },
    ];
    const sections = await getCommentSections(odd as unknown as Targets);
    expect(sections).toHaveLength(3);
    for (const section of sections) expect(section.comments).toEqual([]);
    expect(strapiMock).not.toHaveBeenCalled();
  });
});
