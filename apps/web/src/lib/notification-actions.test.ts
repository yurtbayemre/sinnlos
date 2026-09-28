import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * Notification action characterisation (S09, WD10):
 *   - getNotifications reads the caller's newest 20 (recipient filter from
 *     the session user, actor populated) and, since WD10, the caller's
 *     unread total (meta.pagination.total of a readAt=null query with
 *     pageSize 1) as { items, unreadTotal }; no session user = the empty
 *     feed without a request; any cms failure = the empty feed (the bell
 *     polls on), EXCEPT strapi()'s 401 sign-in redirect, which propagates
 *     (otherwise the bell would poll an expired session forever);
 *   - markNotificationsRead / markAllNotificationsRead have no catch: a 400
 *     rejects with the StrapiError, a 401 redirect propagates. Neither
 *     refreshes (the bell refetches itself).
 */

const strapiMock = vi.fn();
const sessionMock = vi.fn();

vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("@/lib/session", () => ({ getSession: () => sessionMock() }));

const { getNotifications, markAllNotificationsRead, markNotificationsRead } = await import(
  "./notification-actions"
);

function signInRedirect(): unknown {
  try {
    redirect("/sign-in?expired=1");
  } catch (error) {
    return error;
  }
  throw new Error("redirect() did not throw");
}

const cmsError = (status: number) =>
  new StrapiError(status, "Error", JSON.stringify({ error: { status } }));

const ROWS = [
  { id: 2, type: "kudos", title: "Kudos", readAt: null },
  { id: 3, type: "event", title: "Event", readAt: "2026-09-28T09:00:00.000Z" },
];
const LIST_PATH =
  "/api/notifications?filters[recipient][id][$eq]=7&populate[actor]=true&sort=createdAt:desc&pagination[pageSize]=20";
const UNREAD_PATH =
  "/api/notifications?filters[recipient][id][$eq]=7&filters[readAt][$null]=true&fields[0]=id&pagination[pageSize]=1";
const EMPTY = { items: [], unreadTotal: 0 };

/** Answers the list and the unread count (25 without an argument) like the cms does. */
function cms(...total: [unknown?]) {
  const unreadTotal = total.length === 0 ? 25 : total[0];
  strapiMock.mockImplementation(async (path: string) =>
    path === UNREAD_PATH
      ? {
          data: [{ id: 2 }],
          meta: { pagination: { page: 1, pageSize: 1, pageCount: 25, total: unreadTotal } },
        }
      : { data: ROWS, meta: {} },
  );
}

beforeEach(() => {
  strapiMock.mockReset();
  cms();
  sessionMock.mockReset();
  sessionMock.mockResolvedValue({ user: { id: 7 } });
});

describe("getNotifications", () => {
  it("reads the caller's newest 20 with the actor, and the caller's unread total", async () => {
    await expect(getNotifications()).resolves.toEqual({ items: ROWS, unreadTotal: 25 });
    expect(strapiMock).toHaveBeenCalledTimes(2);
    expect(strapiMock.mock.calls.map((call) => call[0]).sort()).toEqual(
      [LIST_PATH, UNREAD_PATH].sort(),
    );
  });

  it("counts unread notifications beyond the 20 loaded ones", async () => {
    cms(150);
    await expect(getNotifications()).resolves.toMatchObject({ unreadTotal: 150 });
    cms(0);
    await expect(getNotifications()).resolves.toMatchObject({ unreadTotal: 0 });
  });

  it.each([undefined, null, -1, 1.5, "25"])(
    "falls back to the unread among the loaded items for a total of %j",
    async (total) => {
      cms(total);
      await expect(getNotifications()).resolves.toEqual({ items: ROWS, unreadTotal: 1 });
    },
  );

  it.each([
    ["no session", null],
    ["a session without a user", {}],
    ["a user without an id", { user: {} }],
  ])("answers the empty feed without a request for %s", async (_label, session) => {
    sessionMock.mockResolvedValue(session);
    await expect(getNotifications()).resolves.toEqual(EMPTY);
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("answers the empty feed for responses without data", async () => {
    strapiMock.mockResolvedValue({});
    await expect(getNotifications()).resolves.toEqual(EMPTY);
  });

  it.each([
    ["a 400", cmsError(400)],
    ["a 500", cmsError(500)],
    ["a network error", new TypeError("fetch failed")],
  ])("answers the empty feed for %s", async (_label, error) => {
    strapiMock.mockRejectedValue(error);
    await expect(getNotifications()).resolves.toEqual(EMPTY);
  });

  it("answers the empty feed when only the unread count fails", async () => {
    strapiMock.mockImplementation(async (path: string) => {
      if (path === UNREAD_PATH) throw cmsError(500);
      return { data: ROWS };
    });
    await expect(getNotifications()).resolves.toEqual(EMPTY);
  });

  it("lets strapi()'s 401 sign-in redirect propagate, from either request", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValue(redirectError);
    await expect(getNotifications()).rejects.toBe(redirectError);
    strapiMock.mockImplementation(async (path: string) => {
      if (path === UNREAD_PATH) throw redirectError;
      return { data: ROWS };
    });
    await expect(getNotifications()).rejects.toBe(redirectError);
  });
});

describe.each([
  [
    "markNotificationsRead",
    () => markNotificationsRead([3, 4]),
    "/api/notifications/mark-read",
    { ids: [3, 4] },
  ],
  [
    "markAllNotificationsRead",
    () => markAllNotificationsRead(),
    "/api/notifications/mark-all-read",
    {},
  ],
])("%s", (_label, action, path, body) => {
  it("posts to its custom route", async () => {
    await expect(action()).resolves.toBeUndefined();
    expect(strapiMock).toHaveBeenCalledTimes(1);
    const [calledPath, init] = strapiMock.mock.calls[0] as [
      string,
      { method: string; body: string },
    ];
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
