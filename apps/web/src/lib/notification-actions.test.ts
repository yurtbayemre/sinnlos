import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * Notification action characterisation (S09):
 *   - getNotifications reads the caller's newest 20 (recipient filter from
 *     the session user, actor populated); no session user = [] without a
 *     request; any cms failure = [] (the bell polls on), EXCEPT strapi()'s
 *     401 sign-in redirect, which propagates (otherwise the bell would poll
 *     an expired session forever);
 *   - markNotificationsRead / markAllNotificationsRead have no catch: a 400
 *     rejects with the StrapiError, a 401 redirect propagates. Neither
 *     refreshes (the bell refetches itself).
 */

const strapiMock = vi.fn();
const sessionMock = vi.fn();

vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("@/lib/session", () => ({ getSession: () => sessionMock() }));

const { getNotifications, markAllNotificationsRead, markNotificationsRead } = await import("./notification-actions");

function signInRedirect(): unknown {
  try {
    redirect("/sign-in?expired=1");
  } catch (error) {
    return error;
  }
  throw new Error("redirect() did not throw");
}

const cmsError = (status: number) => new StrapiError(status, "Error", JSON.stringify({ error: { status } }));

const ROWS = [{ id: 2, type: "kudos", title: "Kudos" }];

beforeEach(() => {
  strapiMock.mockReset();
  strapiMock.mockResolvedValue({ data: ROWS, meta: {} });
  sessionMock.mockReset();
  sessionMock.mockResolvedValue({ user: { id: 7 } });
});

describe("getNotifications", () => {
  it("reads the caller's newest 20 with the actor", async () => {
    await expect(getNotifications()).resolves.toEqual(ROWS);
    expect(strapiMock).toHaveBeenCalledTimes(1);
    expect(strapiMock.mock.calls[0]).toEqual([
      "/api/notifications?filters[recipient][id][$eq]=7&populate[actor]=true&sort=createdAt:desc&pagination[pageSize]=20",
    ]);
  });

  it.each([
    ["no session", null],
    ["a session without a user", {}],
    ["a user without an id", { user: {} }],
  ])("answers [] without a request for %s", async (_label, session) => {
    sessionMock.mockResolvedValue(session);
    await expect(getNotifications()).resolves.toEqual([]);
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("answers [] for a response without data", async () => {
    strapiMock.mockResolvedValue({});
    await expect(getNotifications()).resolves.toEqual([]);
  });

  it.each([
    ["a 400", cmsError(400)],
    ["a 500", cmsError(500)],
    ["a network error", new TypeError("fetch failed")],
  ])("answers [] for %s", async (_label, error) => {
    strapiMock.mockRejectedValue(error);
    await expect(getNotifications()).resolves.toEqual([]);
  });

  it("lets strapi()'s 401 sign-in redirect propagate", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValue(redirectError);
    await expect(getNotifications()).rejects.toBe(redirectError);
  });
});

describe.each([
  ["markNotificationsRead", () => markNotificationsRead([3, 4]), "/api/notifications/mark-read", { ids: [3, 4] }],
  ["markAllNotificationsRead", () => markAllNotificationsRead(), "/api/notifications/mark-all-read", {}],
])("%s", (_label, action, path, body) => {
  it("posts to its custom route", async () => {
    await expect(action()).resolves.toBeUndefined();
    expect(strapiMock).toHaveBeenCalledTimes(1);
    const [calledPath, init] = strapiMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(calledPath).toBe(path);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(body);
  });

  it("rejects with the cms's 400", async () => {
    const error = cmsError(400);
    strapiMock.mockRejectedValue(error);
    await expect(action()).rejects.toBe(error);
  });

  it("lets strapi()'s 401 sign-in redirect propagate", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValue(redirectError);
    await expect(action()).rejects.toBe(redirectError);
  });
});
