import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * sendKudos answers an ActionResult (AC01):
 *   - success: one POST to /api/kudos-entries with recipient, message and
 *     value as given (the cms pins `from` to the caller), then refresh();
 *   - a 400 (an unknown value, kudos to oneself) is "invalid", without a
 *     refresh; a 403 is "forbidden";
 *   - strapi()'s 401 sign-in redirect propagates as the same NEXT_REDIRECT;
 *   - a network error is "unavailable".
 */

const strapiMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("next/cache", () => ({ refresh: () => refreshMock() }));

const { sendKudos } = await import("./kudos-actions");

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

describe("sendKudos", () => {
  it("posts recipient, message and value, then refreshes", async () => {
    await expect(sendKudos(42, "Thanks for the help!", "teamwork")).resolves.toEqual({
      ok: true,
    });
    expect(strapiMock).toHaveBeenCalledTimes(1);
    const [path, init] = strapiMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe("/api/kudos-entries");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      data: { to: 42, message: "Thanks for the help!", value: "teamwork" },
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("answers the cms's 400 as invalid and does not refresh", async () => {
    strapiMock.mockRejectedValue(
      new StrapiError(
        400,
        "Bad Request",
        '{"error":{"message":"Kudos cannot be sent to yourself"}}',
      ),
    );
    await expect(sendKudos(42, "x", "excellence")).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("answers a 403 as forbidden", async () => {
    strapiMock.mockRejectedValue(new StrapiError(403, "Forbidden", ""));
    await expect(sendKudos(42, "x", "excellence")).resolves.toEqual({
      ok: false,
      code: "forbidden",
    });
  });

  it("lets strapi()'s 401 sign-in redirect propagate", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValue(redirectError);
    await expect(sendKudos(42, "x", "innovation")).rejects.toBe(redirectError);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("answers a network error as unavailable", async () => {
    strapiMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(sendKudos(42, "x", "innovation")).resolves.toEqual({
      ok: false,
      code: "unavailable",
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
