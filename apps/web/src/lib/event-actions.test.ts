import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * rsvpToEvent answers an ActionResult (AC01): one endpoint for create AND
 * change, machine codes only.
 *   - statuses outside yes/no/maybe and an empty target never reach the cms
 *     ("invalid"),
 *   - the cms's capacity refusal maps to "full" by status and the parsed
 *     envelope message, compared exactly (no substring of the raw error
 *     text any more); every other answer takes the common mapping,
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
const CAPACITY_REFUSAL = "Event is at capacity";

/** What strapi() throws for a session-token 401: redirect("/sign-in?expired=1"). */
function signInRedirect(): unknown {
  try {
    redirect("/sign-in?expired=1");
  } catch (error) {
    return error;
  }
  throw new Error("redirect() did not throw");
}

/** A Strapi error envelope as ctx.badRequest()/forbidden() send it. */
const cmsError = (status: number, message: string) =>
  new StrapiError(
    status,
    status === 400 ? "Bad Request" : "Error",
    JSON.stringify({
      data: null,
      error: { status, name: status === 400 ? "BadRequestError" : "Error", message, details: {} },
    }),
  );

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

describe("rsvpToEvent", () => {
  it.each(["yes", "no", "maybe"] as const)(
    "posts %s for the target and refreshes",
    async (status) => {
      await expect(rsvpToEvent(DOC, status)).resolves.toEqual({ ok: true });
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
      await expect(rsvpToEvent(DOC, status as "yes")).resolves.toEqual({
        ok: false,
        code: "invalid",
      });
      expect(strapiMock).not.toHaveBeenCalled();
      expect(refreshMock).not.toHaveBeenCalled();
    },
  );

  it("refuses an empty target before any request", async () => {
    await expect(rsvpToEvent("", "yes")).resolves.toEqual({ ok: false, code: "invalid" });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("maps the cms capacity refusal to 'full'", async () => {
    strapiMock.mockRejectedValue(cmsError(400, CAPACITY_REFUSAL));
    await expect(rsvpToEvent(DOC, "yes")).resolves.toEqual({ ok: false, code: "full" });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("matches the capacity text exactly, not as a substring of the error", async () => {
    strapiMock.mockRejectedValue(cmsError(400, `Hint: ${CAPACITY_REFUSAL}`));
    await expect(rsvpToEvent(DOC, "yes")).resolves.toEqual({ ok: false, code: "invalid" });
    strapiMock.mockRejectedValue(cmsError(403, CAPACITY_REFUSAL));
    await expect(rsvpToEvent(DOC, "yes")).resolves.toEqual({ ok: false, code: "forbidden" });
  });

  it.each([
    ["another 400", cmsError(400, "RSVP is not enabled for this event"), "invalid"],
    ["the identical target 400", cmsError(400, "Event not available for RSVP"), "invalid"],
    ["a 403", cmsError(403, "Forbidden"), "forbidden"],
    ["a 500", cmsError(500, "Internal Server Error"), "unavailable"],
    ["a network error", new TypeError("fetch failed"), "unavailable"],
    ["a non-Error rejection", "boom", "failed"],
  ])("maps %s to %s", async (_label, error, code) => {
    strapiMock.mockRejectedValue(error);
    await expect(rsvpToEvent(DOC, "no")).resolves.toEqual({ ok: false, code });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("lets strapi()'s 401 sign-in redirect propagate (NEXT_REDIRECT)", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValue(redirectError);
    await expect(rsvpToEvent(DOC, "maybe")).rejects.toBe(redirectError);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("pins the capacity text the cms controller sends", () => {
    const controller = readFileSync(
      join(__dirname, "../../../cms/src/api/event-rsvp/controllers/event-rsvp.ts"),
      "utf8",
    );
    expect(controller).toContain(`ctx.badRequest("${CAPACITY_REFUSAL}")`);
  });
});
