import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/acknowledgements.ts: the open-confirmation rule shared by the
 * dashboard banner and /announcements (WD02) and the report's chunked ack
 * fetch (FX32). The transport (`@/lib/strapi/client`, WD01) is mocked (the
 * real module pulls in next-auth); the requests (lib/api/announcements.ts)
 * and the page walk (lib/paginate.ts) are the real ones.
 */

const strapiMock = vi.fn();
vi.mock("@/lib/strapi/client", () => ({
  strapi: (...args: unknown[]) => strapiMock(...args),
}));
const viewer = { id: 7 as number | null };
vi.mock("@/lib/viewer", () => ({ getViewer: async () => viewer }));

const { REPORT_ACK_CHUNK, computeOpenAcks, fetchAnnouncementAckIndex, fetchMyAnnouncementAcks } =
  await import("./acknowledgements");

beforeEach(() => {
  strapiMock.mockReset();
  viewer.id = 7;
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
 * The report's index (FX32; v0.31, #173): one POST to the cms report index
 * per REPORT_ACK_CHUNK listed documentIds. The mock answers like the cms:
 * every requested id with its user ids, and `meta.truncated`.
 */
describe("fetchAnnouncementAckIndex (FX32)", () => {
  const doc = (n: number) => `ann${String(n).padStart(21, "0")}`;

  /** Answers like POST /api/acknowledgements/report-index from `table` (documentId → user ids). */
  function serve(table: Record<string, unknown>, truncated = false) {
    strapiMock.mockImplementation(async (_path: string, init: { body: string }) => {
      const { documentIds } = JSON.parse(init.body) as { documentIds: string[] };
      return {
        data: { acks: Object.fromEntries(documentIds.map((id) => [id, table[id] ?? []])) },
        meta: { truncated },
      };
    });
  }

  it("posts the listed documentIds for their type, deduplicated, empty ones dropped", async () => {
    serve({});
    await fetchAnnouncementAckIndex([doc(1), doc(2), doc(1), ""]);
    expect(strapiMock.mock.calls).toEqual([
      [
        "/api/acknowledgements/report-index",
        {
          method: "POST",
          body: JSON.stringify({ targetType: "announcement", documentIds: [doc(1), doc(2)] }),
        },
      ],
    ]);
  });

  it(`asks in chunks of ${REPORT_ACK_CHUNK} and merges them into one index`, async () => {
    const ids = Array.from({ length: 45 }, (_, i) => doc(i + 1));
    serve(Object.fromEntries(ids.map((id, i) => [id, [i + 1, 1000]])));
    const { index, truncated } = await fetchAnnouncementAckIndex(ids);
    expect(truncated).toBe(false);
    expect(index.size).toBe(45);
    expect([...index.get(doc(3))!]).toEqual([3, 1000]);
    expect(
      strapiMock.mock.calls.map(([, init]) => JSON.parse(init.body).documentIds.length),
    ).toEqual([20, 20, 5]);
  });

  it("keeps an entry for a listed item nobody confirmed and ignores what was not asked or no id", async () => {
    serve({ [doc(1)]: [7, "8", null], [doc(9)]: [1] });
    strapiMock.mockImplementationOnce(async () => ({
      data: { acks: { [doc(1)]: [7, "8", null], [doc(9)]: [1], [doc(2)]: "x" } },
      meta: { truncated: false },
    }));
    const { index } = await fetchAnnouncementAckIndex([doc(1), doc(2)]);
    expect([...index].map(([target, users]) => [target, [...users]])).toEqual([
      [doc(1), [7]],
      [doc(2), []],
    ]);
  });

  it("is truncated when the cms stopped a request at its budget", async () => {
    serve({ [doc(1)]: [1] }, true);
    expect((await fetchAnnouncementAckIndex([doc(1)])).truncated).toBe(true);
  });

  it("rejects when a request fails (the page shows its CMS-down banner)", async () => {
    strapiMock.mockRejectedValue(new Error("cms down"));
    await expect(fetchAnnouncementAckIndex([doc(1)])).rejects.toThrow("cms down");
  });

  it("sends no request without items", async () => {
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
      "/api/acknowledgements?filters[targetType][$eq]=announcement&filters[user][id][$eq]=7&sort=id:asc&pagination[page]=1&pagination[pageSize]=100",
    ]);
  });

  it("reads only the caller's rows (admin_role may read everyone's) and fails closed without an id", async () => {
    viewer.id = null;
    await expect(fetchMyAnnouncementAcks()).rejects.toThrow("no viewer id");
    expect(strapiMock).not.toHaveBeenCalled();
  });
});
