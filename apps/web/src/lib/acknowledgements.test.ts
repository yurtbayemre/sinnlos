import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/acknowledgements.ts: the open-confirmation rule shared by the
 * dashboard banner and /announcements (WD02). `@/lib/strapi` is mocked
 * (the real module pulls in next-auth); the helpers under test are pure.
 */

const strapiMock = vi.fn();
vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));

const { computeOpenAcks } = await import("./acknowledgements");

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
