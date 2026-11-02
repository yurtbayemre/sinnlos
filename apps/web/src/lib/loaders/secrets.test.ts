import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * The reads of the secret pages (v0.35): a 404 is the 404 page, a failure
 * logs its status only (never the upstream body), a malformed id never
 * reaches the cms, `?sentPage=` is the cms's range or 1.
 */

const strapiMock = vi.fn();
vi.mock("@/lib/strapi", async () => ({
  strapi: (...args: unknown[]) => strapiMock(...args),
  StrapiError: (await import("@/lib/strapi-error")).StrapiError,
}));

const { loadSecretDetail, loadSecretList, sentPageOf } = await import("./secrets");

const ID = "abcdefghijklmnopqrstuvwx";
const SENTINEL = "sentinel-7f3a-do-not-log";
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  strapiMock.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("secret page reads", () => {
  it("takes sentPage 1 to 100, else 1", () => {
    expect(["1", "2", "100"].map(sentPageOf)).toEqual([1, 2, 100]);
    expect(["0", "101", "-1", "2.5", "x", undefined, ["2"]].map(sentPageOf)).toEqual([
      1, 1, 1, 1, 1, 1, 1,
    ]);
  });

  it("reads the list, and a failure is null with the status logged alone", async () => {
    strapiMock.mockResolvedValueOnce({ data: { received: [], sent: [], hasMore: false } });
    await expect(loadSecretList(2)).resolves.toEqual({ received: [], sent: [], hasMore: false });
    expect(strapiMock).toHaveBeenCalledWith("/api/secret-shares?sentPage=2");
    strapiMock.mockRejectedValueOnce(new StrapiError(500, "x", SENTINEL));
    await expect(loadSecretList(1)).resolves.toBeNull();
    expect(warn.mock.calls.map((c: unknown[]) => c.join(" "))).toEqual([
      "[secrets] list failed: 500",
    ]);
  });

  it("answers 404 and a malformed id with the 404 page", async () => {
    await expect(loadSecretDetail("nope")).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
    expect(strapiMock).not.toHaveBeenCalled();
    strapiMock.mockRejectedValueOnce(new StrapiError(404, "x", SENTINEL));
    await expect(loadSecretDetail(ID)).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it("throws a fixed error when the detail cannot be read", async () => {
    strapiMock.mockRejectedValueOnce(new StrapiError(503, "x", SENTINEL));
    await expect(loadSecretDetail(ID)).rejects.toThrow("[secrets] the share could not be read");
    expect(warn.mock.calls.map((c: unknown[]) => c.join(" "))).toEqual([
      "[secrets] detail failed: 503",
    ]);
  });
});
