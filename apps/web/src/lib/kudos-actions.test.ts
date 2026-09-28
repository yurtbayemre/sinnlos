import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * sendKudos characterisation (S09). The action has no catch:
 *   - success: one POST to /api/kudos-entries with recipient, message and
 *     value as given (the cms pins `from` to the caller), then refresh();
 *   - a 400 (e.g. an unknown value, or kudos to oneself once FX27 lands)
 *     rejects with the StrapiError and does not refresh;
 *   - strapi()'s 401 sign-in redirect propagates as the same NEXT_REDIRECT.
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
});

describe("sendKudos", () => {
  it("posts recipient, message and value, then refreshes", async () => {
    await expect(sendKudos(42, "Thanks for the help!", "teamwork")).resolves.toBeUndefined();
    expect(strapiMock).toHaveBeenCalledTimes(1);
    const [path, init] = strapiMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe("/api/kudos-entries");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ data: { to: 42, message: "Thanks for the help!", value: "teamwork" } });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("rejects with the cms's 400 and does not refresh", async () => {
    const error = new StrapiError(400, "Bad Request", '{"error":{"message":"Invalid kudos"}}');
    strapiMock.mockRejectedValue(error);
    await expect(sendKudos(42, "x", "excellence")).rejects.toBe(error);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("lets strapi()'s 401 sign-in redirect propagate", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValue(redirectError);
    await expect(sendKudos(42, "x", "innovation")).rejects.toBe(redirectError);
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
