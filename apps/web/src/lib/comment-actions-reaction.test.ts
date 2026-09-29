import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * toggleReaction sends the desired end state (FX28): `data.reacted` next
 * to the documentId anchor, as a strict boolean. The CMS makes a repeated
 * request a no-op; one that predates the key ignores it and toggles.
 * `@/lib/strapi` and `@/lib/session` are mocked; only the request matters.
 */
const strapiMock = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>();

vi.mock("@/lib/strapi", () => ({
  strapi: (path: string, init?: RequestInit) => strapiMock(path, init),
}));
vi.mock("@/lib/session", () => ({ getSession: async () => ({ user: { id: 7 } }) }));
vi.mock("next/navigation", () => ({ unstable_rethrow: () => {} }));

const { toggleReaction } = await import("./comment-actions");

const target = { type: "announcement", documentId: "doc-a" } as const;

/** The `data` object of the one POST toggleReaction sent. */
function sentData(): Record<string, unknown> {
  expect(strapiMock).toHaveBeenCalledTimes(1);
  const [path, init] = strapiMock.mock.calls[0]!;
  expect(path).toBe("/api/reactions");
  expect(init?.method).toBe("POST");
  return (JSON.parse(String(init?.body)) as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  strapiMock.mockReset();
  strapiMock.mockResolvedValue({ data: { id: 1 } });
});

describe("toggleReaction (FX28)", () => {
  it.each([true, false])("sends the desired state reacted=%s with the anchor", async (reacted) => {
    await expect(toggleReaction(target, "heart", reacted)).resolves.toEqual({ ok: true });
    expect(sentData()).toEqual({
      emoji: "heart",
      targetType: "announcement",
      targetDocumentId: "doc-a",
      reacted,
    });
  });

  it("sends a strict boolean whatever a crafted call passes", async () => {
    await toggleReaction(target, "heart", "true" as unknown as boolean);
    expect(sentData().reacted).toBe(false);
  });

  it("refuses to write without a documentId anchor", async () => {
    await expect(
      toggleReaction({ type: "announcement", documentId: null }, "heart", true),
    ).resolves.toEqual({ ok: false, code: "invalid" });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("answers a failed write as a code (the bar shows the error)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    strapiMock.mockRejectedValue(new Error("boom"));
    await expect(toggleReaction(target, "heart", true)).resolves.toEqual({
      ok: false,
      code: "failed",
    });
  });
});
