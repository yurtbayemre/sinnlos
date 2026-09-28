import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * rsvpToEvent characterisation (S09): one endpoint for create AND change,
 * machine error codes only.
 *   - statuses outside yes/no/maybe and an empty target never reach the cms,
 *   - the cms's "Event is at capacity" 400 maps to "full", every other
 *     failure (other 400s, 403, 500, network) to "failed",
 *   - strapi()'s 401 sign-in redirect (NEXT_REDIRECT) propagates untouched
 *     (FX47), with no refresh,
 *   - success refreshes the server-rendered attendee lists.
 * strapi() and next/cache are mocked; next/navigation is the real one, so
 * the redirect is a genuine NEXT_REDIRECT and unstable_rethrow the real check.
 */

const strapiMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("next/cache", () => ({ refresh: () => refreshMock() }));

const { rsvpToEvent } = await import("./event-actions");

const DOC = "k3m9x0000000000000000000";

/** What strapi() throws for a session-token 401: redirect("/sign-in?expired=1"). */
function signInRedirect(): unknown {
  try {
    redirect("/sign-in?expired=1");
  } catch (error) {
    return error;
  }
  throw new Error("redirect() did not throw");
}

const cmsError = (status: number, message: string) =>
  new StrapiError(
    status,
    status === 400 ? "Bad Request" : "Error",
    JSON.stringify({ error: { status, message } }),
  );

beforeEach(() => {
  strapiMock.mockReset();
  strapiMock.mockResolvedValue({ data: { id: 1 } });
  refreshMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rsvpToEvent", () => {
  it.each(["yes", "no", "maybe"] as const)(
    "posts %s for the target and refreshes",
    async (status) => {
      await expect(rsvpToEvent(DOC, status)).resolves.toEqual({});
      expect(strapiMock).toHaveBeenCalledTimes(1);
      const [path, init] = strapiMock.mock.calls[0] as [string, { method: string; body: string }];
      expect(path).toBe("/api/event-rsvps");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ data: { targetDocumentId: DOC, status } });
      expect(refreshMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["YES", "", "attending", "__proto__", "declined"])(
    "refuses status %j before any request",
    async (status) => {
      await expect(rsvpToEvent(DOC, status as "yes")).resolves.toEqual({ error: "failed" });
      expect(strapiMock).not.toHaveBeenCalled();
      expect(refreshMock).not.toHaveBeenCalled();
    },
  );

  it("refuses an empty target before any request", async () => {
    await expect(rsvpToEvent("", "yes")).resolves.toEqual({ error: "failed" });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("maps the cms capacity rejection to 'full'", async () => {
    strapiMock.mockRejectedValue(cmsError(400, "Event is at capacity"));
    await expect(rsvpToEvent(DOC, "yes")).resolves.toEqual({ error: "full" });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it.each([
    ["another 400", cmsError(400, "RSVP is not enabled for this event")],
    ["the identical target 400", cmsError(400, "Target not available for RSVP")],
    ["a 403", cmsError(403, "Forbidden")],
    ["a 500", cmsError(500, "Internal Server Error")],
    ["a network error", new TypeError("fetch failed")],
    ["a non-Error rejection", "boom"],
  ])("maps %s to 'failed'", async (_label, error) => {
    strapiMock.mockRejectedValue(error);
    await expect(rsvpToEvent(DOC, "no")).resolves.toEqual({ error: "failed" });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("lets strapi()'s 401 sign-in redirect propagate (NEXT_REDIRECT)", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValue(redirectError);
    await expect(rsvpToEvent(DOC, "maybe")).rejects.toBe(redirectError);
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
