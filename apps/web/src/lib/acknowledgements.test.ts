import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/acknowledgements.ts: the open-confirmation rule shared by the
 * dashboard banner and /announcements (WD02) and the report's chunked ack
 * fetch (FX32). `@/lib/strapi` is mocked (the real module pulls in
 * next-auth); the page walk (lib/paginate.ts) is the real one.
 */

const strapiMock = vi.fn();
vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));

const {
  REPORT_ACK_CHUNK,
  REPORT_ACK_MAX_PAGES,
  computeOpenAcks,
  fetchAnnouncementAckIndex,
  fetchMyAnnouncementAcks,
} = await import("./acknowledgements");

beforeEach(() => {
  strapiMock.mockReset();
});

describe("computeOpenAcks", () => {
  const ann = (id: number, documentId: string | undefined, requiresAck = true) => ({
    id,
    documentId,
    requiresAck,
  });

  it("lists the mandatory announcements without an own ack, in list order", () => {
    const open = computeOpenAcks(
      [ann(1, "docA"), ann(2, "docB"), ann(3, "docC")],
      [{ targetDocumentId: "docB" }],
    );
    expect(open.map((a) => a.id)).toEqual([1, 3]);
  });

  it("re-checks requiresAck and skips announcements without a documentId", () => {
    const open = computeOpenAcks([ann(1, "docA", false), ann(2, undefined), ann(3, "")], []);
    expect(open).toEqual([]);
  });

  it("collapses duplicate ack rows and ignores acks of unlisted announcements", () => {
    const open = computeOpenAcks(
      [ann(1, "docA"), ann(2, "docB")],
      [{ targetDocumentId: "docA" }, { targetDocumentId: "docA" }, { targetDocumentId: "docZ" }],
    );
    expect(open.map((a) => a.id)).toEqual([2]);
  });

  it("returns the caller's own objects (the page swaps in its fuller copy by documentId)", () => {
    const first = ann(1, "docA");
    expect(computeOpenAcks([first], [])[0]).toBe(first);
  });

  it("needs no request", () => {
    computeOpenAcks([ann(1, "docA")], []);
    expect(strapiMock).not.toHaveBeenCalled();
  });
});

/**
 * FX32: the report's acks are fetched per chunk of the listed mandatory
 * announcements, each chunk walk with its own cap, and aggregated into one
 * documentId → users index. strapi() is mocked with a small ack table that
 * honours the chunk's `$in` list and the page params.
 */
describe("fetchAnnouncementAckIndex (FX32)", () => {
  const doc = (n: number) => `ann${String(n).padStart(21, "0")}`;
  type AckRow = { id: number; targetDocumentId: string; user: { id: number } | null };

  /** Answers like /api/acknowledgements: the rows of the requested targets, paged. */
  function serve(table: AckRow[], pageSize = 100) {
    strapiMock.mockImplementation(async (path: string) => {
      const url = new URL(`http://cms.test${path}`);
      const targets = [...url.searchParams.entries()]
        .filter(([key]) => key.startsWith("filters[targetDocumentId][$in]"))
        .map(([, value]) => value);
      const page = Number(url.searchParams.get("pagination[page]"));
      const rows = table.filter((row) => targets.includes(row.targetDocumentId));
      const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
      return {
        data: rows.slice((page - 1) * pageSize, page * pageSize),
        meta: { pagination: { page, pageSize, pageCount, total: rows.length } },
      };
    });
  }

  it("asks per chunk of listed documentIds, only for the target and the user id", async () => {
    serve([]);
    await fetchAnnouncementAckIndex([doc(1), doc(2)]);
    expect(strapiMock.mock.calls.map(([path]) => path)).toEqual([
      `/api/acknowledgements?filters[targetType][$eq]=announcement&filters[targetDocumentId][$in][0]=${doc(1)}&filters[targetDocumentId][$in][1]=${doc(2)}&fields[0]=targetDocumentId&populate[user][fields][0]=id&sort[0]=id:asc&pagination[page]=1&pagination[pageSize]=100`,
    ]);
  });

  it("aggregates every chunk and page into one index, beyond the old 2000-row cap", async () => {
    // 45 announcements (3 chunks of 20, 20, 5) x 60 users = 2700 acks,
    // plus a duplicate row and a row of a deleted account.
    const ids = Array.from({ length: 45 }, (_, i) => doc(i + 1));
    let id = 1;
    const table: AckRow[] = ids.flatMap((target) =>
      Array.from({ length: 60 }, (_, u) => ({
        id: id++,
        targetDocumentId: target,
        user: { id: u + 1 },
      })),
    );
    table.push({ id: id++, targetDocumentId: doc(1), user: { id: 1 } });
    table.push({ id: id++, targetDocumentId: doc(2), user: null });
    serve(table);

    const { index, truncated } = await fetchAnnouncementAckIndex([...ids, doc(1), ""]);
    expect(truncated).toBe(false);
    expect(index.size).toBe(45);
    for (const target of ids) expect(index.get(target)?.size, target).toBe(60);

    const chunks = strapiMock.mock.calls.map(([path]) => {
      const url = new URL(`http://cms.test${path as string}`);
      return [...url.searchParams.keys()].filter((key) => key.includes("[$in]")).length;
    });
    // Chunk 1: 1200 + 2 extra rows = 13 pages, chunk 2: 1200 rows = 12
    // pages, chunk 3: 5 x 60 = 3 pages. The duplicate target is asked once.
    expect(chunks).toEqual([...Array(25).fill(20), 5, 5, 5]);
  });

  it("keeps an entry for a listed announcement nobody confirmed", async () => {
    serve([{ id: 1, targetDocumentId: doc(1), user: { id: 7 } }]);
    const { index } = await fetchAnnouncementAckIndex([doc(1), doc(2)]);
    expect([...index].map(([target, users]) => [target, [...users]])).toEqual([
      [doc(1), [7]],
      [doc(2), []],
    ]);
  });

  it(`flags the index truncated when a chunk walk hits its own cap (${REPORT_ACK_MAX_PAGES} pages)`, async () => {
    strapiMock.mockImplementation(async (path: string) => {
      const page = Number(new URL(`http://cms.test${path}`).searchParams.get("pagination[page]"));
      return {
        data: [{ id: page, targetDocumentId: doc(1), user: { id: page } }],
        meta: { pagination: { page, pageSize: 100, pageCount: 1_000_000, total: 100_000_000 } },
      };
    });
    const { index, truncated } = await fetchAnnouncementAckIndex([doc(1)]);
    expect(truncated).toBe(true);
    expect(strapiMock).toHaveBeenCalledTimes(REPORT_ACK_MAX_PAGES);
    expect(index.get(doc(1))?.size).toBe(REPORT_ACK_MAX_PAGES);
    expect(REPORT_ACK_MAX_PAGES).toBe((REPORT_ACK_CHUNK * 2000) / 100);
  });

  it("rejects when a request fails (the page shows its CMS-down banner)", async () => {
    strapiMock.mockRejectedValue(new Error("cms down"));
    await expect(fetchAnnouncementAckIndex([doc(1)])).rejects.toThrow("cms down");
  });

  it("sends no request without announcements", async () => {
    await expect(fetchAnnouncementAckIndex([])).resolves.toEqual({
      index: new Map(),
      truncated: false,
    });
    expect(strapiMock).not.toHaveBeenCalled();
  });
});

describe("fetchMyAnnouncementAcks", () => {
  it("walks the caller's own acks with its own 20-page cap", async () => {
    strapiMock.mockImplementation(async (path: string) => {
      const page = Number(new URL(`http://cms.test${path}`).searchParams.get("pagination[page]"));
      return {
        data: [{ id: page, targetDocumentId: "a" }],
        meta: { pagination: { page, pageSize: 100, pageCount: 99, total: 9900 } },
      };
    });
    const result = await fetchMyAnnouncementAcks();
    expect(result.truncated).toBe(true);
    expect(result.acks).toHaveLength(20);
    expect(strapiMock.mock.calls[0]).toEqual([
      "/api/acknowledgements?filters[targetType][$eq]=announcement&sort=id:asc&pagination[page]=1&pagination[pageSize]=100",
    ]);
  });
});
