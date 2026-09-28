import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * acknowledgeAnnouncement characterisation (S09). The action has no catch:
 *   - success: one POST naming only the target (by documentId; the cms takes
 *     the user from the JWT), then refresh() so the banner and the list
 *     update;
 *   - a 400 (e.g. the cms's identical "Target not available" answer)
 *     rejects with the StrapiError and does not refresh;
 *   - strapi()'s 401 sign-in redirect propagates as the same NEXT_REDIRECT.
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
});

describe("acknowledgeAnnouncement", () => {
  it("posts the announcement target by documentId, then refreshes", async () => {
    await expect(acknowledgeAnnouncement(DOC)).resolves.toBeUndefined();
    expect(strapiMock).toHaveBeenCalledTimes(1);
    const [path, init] = strapiMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe("/api/acknowledgements");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ data: { targetType: "announcement", targetDocumentId: DOC } });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("rejects with the cms's 400 and does not refresh", async () => {
    const error = new StrapiError(400, "Bad Request", '{"error":{"message":"Target not available for acknowledgement"}}');
    strapiMock.mockRejectedValue(error);
    await expect(acknowledgeAnnouncement(DOC)).rejects.toBe(error);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("lets strapi()'s 401 sign-in redirect propagate", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValue(redirectError);
    await expect(acknowledgeAnnouncement(DOC)).rejects.toBe(redirectError);
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
