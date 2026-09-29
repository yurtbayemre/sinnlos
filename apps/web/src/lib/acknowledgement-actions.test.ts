import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * acknowledgeAnnouncement answers an ActionResult (AC01):
 *   - success: one POST naming only the target (by documentId; the cms takes
 *     the user from the JWT), then refresh() so the banner and the list
 *     update;
 *   - the cms's identical 400 ("Target not available", "Already
 *     acknowledged") is "invalid", without a refresh;
 *   - strapi()'s 401 sign-in redirect propagates as the same NEXT_REDIRECT;
 *   - a network error is "unavailable";
 *   - an argument that is no documentId never reaches the cms.
 */

const strapiMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("next/cache", () => ({ refresh: () => refreshMock() }));

const { acknowledgeAnnouncement } = await import("./acknowledgement-actions");

const DOC = "k3m9x0000000000000000000";

function signInRedirect(): unknown {
  try {
    redirect("/sign-in?expired=1");
  } catch (error) {
    return error;
  }
  throw new Error("redirect() did not throw");
}

beforeEach(() => {
  strapiMock.mockReset();
  strapiMock.mockResolvedValue({ data: { id: 1 } });
  refreshMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("acknowledgeAnnouncement", () => {
  it("posts the announcement target by documentId, then refreshes", async () => {
    await expect(acknowledgeAnnouncement(DOC)).resolves.toEqual({ ok: true });
    expect(strapiMock).toHaveBeenCalledTimes(1);
    const [path, init] = strapiMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe("/api/acknowledgements");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      data: { targetType: "announcement", targetDocumentId: DOC },
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("answers the cms's 400 as invalid and does not refresh", async () => {
    strapiMock.mockRejectedValue(
      new StrapiError(
        400,
        "Bad Request",
        '{"error":{"name":"BadRequestError","message":"Target not available for acknowledgement"}}',
      ),
    );
    await expect(acknowledgeAnnouncement(DOC)).resolves.toEqual({ ok: false, code: "invalid" });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("lets strapi()'s 401 sign-in redirect propagate", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValue(redirectError);
    await expect(acknowledgeAnnouncement(DOC)).rejects.toBe(redirectError);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("answers a network error as unavailable", async () => {
    strapiMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(acknowledgeAnnouncement(DOC)).resolves.toEqual({
      ok: false,
      code: "unavailable",
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it.each(["", 7, null, undefined])("refuses %j before any request", async (doc) => {
    await expect(acknowledgeAnnouncement(doc as unknown as string)).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    expect(strapiMock).not.toHaveBeenCalled();
  });
});
