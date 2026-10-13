import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "@/lib/strapi-error";
import type { Viewer } from "@/lib/viewer";
import { emptyAnnouncementValues, emptyEventValues, emptyPollValues } from "./values";

/**
 * The /manage Server Actions on AC01 against the K7 HTTP contract (decision
 * 06 §B3, §B5, §L3; batch 15 plan 15C tests "per action"), with strapi()
 * mocked: the request each intent sends (path, method, `status`,
 * `If-Match`), the payload a class may send, and the mapping of every
 * answer: success, 400 with fields, 412 conflict with the current version,
 * 428 failed and logged, the 401 sign-in redirect rethrown, a network error
 * unavailable. The capability values are batch 15's (K8,
 * k8-capabilities.test.helper.ts); next/navigation is the real module, so
 * the redirect is a genuine NEXT_REDIRECT.
 */

const strapiMock = vi.fn();
const refreshMock = vi.fn();
const viewerRef: { current: Viewer } = { current: null as unknown as Viewer };

vi.mock("@/lib/strapi/client", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("next/cache", () => ({ refresh: () => refreshMock() }));
vi.mock("@/lib/viewer", () => ({ getViewer: async () => viewerRef.current }));
vi.mock("@/lib/roles", async (original) => {
  const roles = await original<typeof import("@/lib/roles")>();
  const { k8Capabilities } = await import("./k8-capabilities.test.helper");
  return { ...roles, capabilitiesFor: (role: string | null) => k8Capabilities(roles, role) };
});

const announcements = await import("./announcement-actions");
const events = await import("./event-actions");
const polls = await import("./poll-actions");
const quickLinks = await import("./quick-link-actions");

const ENG = { id: 3, documentId: "deptengineering000000000", name: "Engineering", slug: "eng" };
const DOC = "annc00000000000000000001";

const viewer = (role: string | null, department: Viewer["department"] = null): Viewer => ({
  id: 7,
  displayName: "Ada",
  role,
  department,
});
const EDITOR = viewer("editor");
const HEAD = viewer("department_head", ENG);

/** What strapi() throws for a session-token 401: redirect("/sign-in?expired=1"). */
function signInRedirect(): unknown {
  try {
    redirect("/sign-in?expired=1");
  } catch (error) {
    return error;
  }
  throw new Error("redirect() did not throw");
}

/** A Strapi error envelope with `details`. */
const cmsError = (status: number, details: Record<string, unknown> = {}, name = "Error") =>
  new StrapiError(
    status,
    "Error",
    JSON.stringify({ data: null, error: { status, name, message: "refused", details } }),
  );

const dto = (patch: Record<string, unknown> = {}) => ({
  data: { documentId: DOC, version: "5", status: "draft", publishedAt: null, ...patch },
});

/** The [path, init] of the n-th strapi() call. */
function call(n = 0): {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
} {
  const [path, init] = strapiMock.mock.calls[n] as [
    string,
    { method?: string; headers?: Record<string, string>; body?: string },
  ];
  return {
    path,
    method: init?.method ?? "GET",
    headers: init?.headers ?? {},
    body: init?.body ? JSON.parse(init.body) : undefined,
  };
}

const announcement = (patch: Record<string, unknown> = {}) => ({
  ...emptyAnnouncementValues(),
  title: "Canteen closed",
  ...patch,
});

beforeEach(() => {
  strapiMock.mockReset().mockResolvedValue(dto());
  refreshMock.mockReset();
  viewerRef.current = EDITOR;
  vi.stubEnv("APP_TIME_ZONE", "Europe/Berlin");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("saves (create and update)", () => {
  it("creates a draft: POST with ?status=draft, no If-Match, the cms's DTO back, no refresh", async () => {
    await expect(
      announcements.saveAnnouncement({ status: "draft", values: announcement() }),
    ).resolves.toEqual({ ok: true, data: dto().data });
    const sent = call();
    expect(sent.path).toBe("/api/announcements?status=draft");
    expect(sent.method).toBe("POST");
    expect(sent.headers).not.toHaveProperty("If-Match");
    expect(sent.body).toEqual({
      data: {
        title: "Canteen closed",
        body: null,
        pinned: false,
        expiresAt: null,
        department: null,
        team: null,
        audienceRoles: [],
        requiresAck: false,
        ackDeadline: null,
      },
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("saves and publishes: PUT with ?status=published and If-Match, the changed fields only, a refresh", async () => {
    const initial = announcement();
    strapiMock.mockResolvedValue(dto({ status: "published", version: "6" }));
    const result = await announcements.saveAnnouncement({
      documentId: DOC,
      version: "5",
      status: "published",
      values: { ...initial, title: "Canteen open" },
      initial,
    });
    expect(result).toEqual({ ok: true, data: dto({ status: "published", version: "6" }).data });
    const sent = call();
    expect(sent.path).toBe(`/api/announcements/${DOC}?status=published`);
    expect(sent.method).toBe("PUT");
    expect(sent.headers).toEqual({ "If-Match": '"5"' });
    expect(sent.body).toEqual({ data: { title: "Canteen open" } });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("maps a 400 to invalid with the fields of details.keys/codes", async () => {
    strapiMock.mockRejectedValue(
      cmsError(400, { keys: ["pinned", "title"], codes: { title: "tooLong" } }, "ValidationError"),
    );
    await expect(
      announcements.saveAnnouncement({ status: "draft", values: announcement() }),
    ).resolves.toEqual({
      ok: false,
      code: "invalid",
      fields: { pinned: "invalid", title: "tooLong" },
    });
  });

  it("maps a 412 to conflict with the current version", async () => {
    strapiMock.mockRejectedValue(cmsError(412, { current: 9 }));
    await expect(
      announcements.saveAnnouncement({
        documentId: DOC,
        version: "5",
        status: "draft",
        values: announcement(),
        initial: announcement(),
      }),
    ).resolves.toEqual({ ok: false, code: "conflict", version: "9" });
  });

  it("maps a 428 (If-Match missing: a web bug) to failed and logs it as an error", async () => {
    strapiMock.mockRejectedValue(cmsError(428));
    await expect(
      announcements.saveAnnouncement({
        documentId: DOC,
        version: "5",
        status: "draft",
        values: announcement(),
        initial: announcement(),
      }),
    ).resolves.toEqual({ ok: false, code: "failed" });
    expect(console.error).toHaveBeenCalled();
  });

  it("rethrows the sign-in redirect and maps a network error to unavailable", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValueOnce(redirectError);
    await expect(
      announcements.saveAnnouncement({ status: "draft", values: announcement() }),
    ).rejects.toBe(redirectError);
    strapiMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(
      announcements.saveAnnouncement({ status: "draft", values: announcement() }),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
  });

  it("refuses locally before any request: the domain checks and reject-mode dates", async () => {
    await expect(
      announcements.saveAnnouncement({ status: "draft", values: announcement({ title: "" }) }),
    ).resolves.toEqual({ ok: false, code: "invalid", fields: { title: "required" } });
    await expect(
      events.saveEvent({
        status: "draft",
        values: {
          ...emptyEventValues(),
          title: "Night",
          startDate: "2027-03-28",
          startTime: "02:30",
        },
      }),
    ).resolves.toEqual({ ok: false, code: "invalid", fields: { start: "timeSkipped" } });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("refuses a missing status, a bad reference or version, before any request", async () => {
    for (const input of [
      { status: "maybe", values: announcement() },
      { documentId: "../../users", version: "5", status: "draft", values: announcement() },
      { documentId: DOC, version: "W/5", status: "draft", values: announcement() },
      { documentId: DOC, status: "draft", values: announcement() },
    ]) {
      await expect(announcements.saveAnnouncement(input)).resolves.toEqual({
        ok: false,
        code: "invalid",
      });
    }
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("reads an argument that is no object as an empty save, never a TypeError", async () => {
    for (const input of [null, "x", 42, [1]]) {
      await expect(announcements.saveAnnouncement(input as never)).resolves.toEqual({
        ok: false,
        code: "invalid",
      });
      await expect(polls.savePoll(input as never)).resolves.toMatchObject({ ok: false });
    }
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("answers forbidden without the capability, unavailable without a readable viewer", async () => {
    for (const role of ["member", "guest", "team_lead", null, "Editor"]) {
      viewerRef.current = viewer(role);
      await expect(
        announcements.saveAnnouncement({ status: "draft", values: announcement() }),
      ).resolves.toEqual({ ok: false, code: "forbidden" });
    }
    viewerRef.current = { ...EDITOR, id: null };
    await expect(
      announcements.saveAnnouncement({ status: "draft", values: announcement() }),
    ).resolves.toEqual({ ok: false, code: "unavailable" });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("schedules a quick link: status=draft with publishAt and unpublishAt", async () => {
    await quickLinks.saveQuickLink({
      status: "draft",
      values: {
        label: "Wiki",
        url: "/wiki",
        icon: "",
        category: "tools",
        order: "0",
        departments: [],
      },
      schedule: {
        publishDate: "2030-01-02",
        publishTime: "08:00",
        unpublishDate: "2030-02-01",
        unpublishTime: "08:00",
      },
    });
    const sent = call();
    expect(sent.path).toBe("/api/quick-links?status=draft");
    expect(sent.body).toMatchObject({
      data: { publishAt: "2030-01-02T07:00:00.000Z", unpublishAt: "2030-02-01T07:00:00.000Z" },
    });
  });
});

describe("a widening re-target needs the confirmation, checked against the cms (Codex review)", () => {
  // The form after choosing "Everyone" on an item with a surviving
  // department and a deleted team: department, team and roles empty.
  const initial = announcement({ department: ENG.documentId });
  const everyone = announcement({ department: "", team: "", audienceRoles: [] });
  const editableAnswer = (needsRetarget: boolean) => ({
    data: { documentId: DOC, version: "5", status: "published", needsRetarget },
  });

  it("refuses the save when the cms says the item needs re-targeting: no write is sent", async () => {
    strapiMock.mockReset().mockResolvedValueOnce(editableAnswer(true));
    const result = await announcements.saveAnnouncement({
      documentId: DOC,
      version: "5",
      status: "published",
      values: everyone,
      initial,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "invalid",
      fields: { department: "confirmAudience" },
    });
    expect(strapiMock).toHaveBeenCalledTimes(1);
    expect(call(0).path).toBe(`/api/announcements/${DOC}/editable`);
  });

  it("sends it with the confirmation (no extra read), and when the cms says nothing is restricted", async () => {
    strapiMock.mockReset().mockResolvedValue(dto());
    await announcements.saveAnnouncement({
      documentId: DOC,
      version: "5",
      status: "published",
      values: everyone,
      initial,
      retarget: true,
    });
    expect(strapiMock).toHaveBeenCalledTimes(1);
    expect(call(0).method).toBe("PUT");
    expect(call(0).body).toMatchObject({
      data: { department: null, team: null, audienceRoles: [] },
    });

    strapiMock.mockReset().mockResolvedValueOnce(editableAnswer(false)).mockResolvedValue(dto());
    await announcements.saveAnnouncement({
      documentId: DOC,
      version: "5",
      status: "published",
      values: everyone,
      initial,
    });
    expect(call(0).path).toBe(`/api/announcements/${DOC}/editable`);
    expect(call(1).method).toBe("PUT");
  });
});

describe("state transitions", () => {
  it.each([
    ["publish", announcements.publishAnnouncement, `/api/announcements/${DOC}/publish`, "POST"],
    [
      "unpublish",
      announcements.unpublishAnnouncement,
      `/api/announcements/${DOC}/unpublish`,
      "POST",
    ],
    [
      "discard",
      announcements.discardAnnouncement,
      `/api/announcements/${DOC}/discard-draft`,
      "POST",
    ],
    ["publish an event", events.publishEvent, `/api/events/${DOC}/publish`, "POST"],
    [
      "unpublish a quick link",
      quickLinks.unpublishQuickLink,
      `/api/quick-links/${DOC}/unpublish`,
      "POST",
    ],
  ] as const)("%s: the route with If-Match, a refresh", async (_name, action, path, method) => {
    await expect(action(DOC, "5")).resolves.toEqual({ ok: true, data: dto().data });
    expect(call()).toMatchObject({ path, method, headers: { "If-Match": '"5"' } });
    expect(call().body).toBeUndefined();
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("deletes with If-Match: a 204 is data null, without a refresh (the form navigates)", async () => {
    strapiMock.mockResolvedValue(undefined);
    await expect(announcements.deleteAnnouncement(DOC, "5")).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(call()).toMatchObject({
      path: `/api/announcements/${DOC}`,
      method: "DELETE",
      headers: { "If-Match": '"5"' },
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("a moderator's discard of a never-published draft deletes it (204): data null, no refresh", async () => {
    strapiMock.mockResolvedValue(undefined);
    await expect(announcements.discardAnnouncement(DOC, "5")).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("refuses a bad reference before any request", async () => {
    await expect(announcements.publishAnnouncement("x", "5")).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    await expect(announcements.publishAnnouncement(DOC, "")).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    expect(strapiMock).not.toHaveBeenCalled();
  });
});

describe("department authors (§N2, §N4)", () => {
  beforeEach(() => {
    viewerRef.current = HEAD;
  });

  it("creates with the department pinned and never a moderator-only key", async () => {
    await announcements.saveAnnouncement({
      status: "published",
      values: announcement({
        pinned: true,
        requiresAck: true,
        ackDeadline: "2030-01-01",
        department: "deptsales000000000000000",
      }),
    });
    const { body } = call();
    const data = (body as { data: Record<string, unknown> }).data;
    expect(data.department).toBe(ENG.documentId);
    for (const key of ["pinned", "requiresAck", "ackDeadline", "publishAt", "ownerDepartment"]) {
      expect(data, key).not.toHaveProperty(key);
    }
    await events.saveEvent({
      status: "draft",
      values: {
        ...emptyEventValues(),
        title: "Offsite",
        startDate: "2030-05-04",
        startTime: "09:00",
      },
    });
    expect((call(1).body as { data: Record<string, unknown> }).data.departments).toEqual([
      ENG.documentId,
    ]);
  });

  it("may not schedule, delete or author quick links and polls", async () => {
    const results = await Promise.all([
      announcements.saveAnnouncement({
        status: "draft",
        values: announcement(),
        schedule: {
          publishDate: "2030-01-02",
          publishTime: "08:00",
          unpublishDate: "",
          unpublishTime: "",
        },
      }),
      announcements.deleteAnnouncement(DOC, "5"),
      quickLinks.saveQuickLink({ status: "draft", values: {} }),
      polls.savePoll({ values: emptyPollValues() }),
    ]);
    for (const result of results) expect(result).toEqual({ ok: false, code: "forbidden" });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("publishes, unpublishes and discards their own items", async () => {
    await expect(announcements.publishAnnouncement(DOC, "5")).resolves.toMatchObject({ ok: true });
    await expect(events.unpublishEvent(DOC, "6")).resolves.toMatchObject({ ok: true });
    await expect(announcements.discardAnnouncement(DOC, "7")).resolves.toMatchObject({ ok: true });
  });

  it("maps the cms's neverPublished refusal of a discard to the _form field", async () => {
    strapiMock.mockRejectedValue(
      cmsError(400, { keys: ["_form"], codes: { _form: "neverPublished" } }, "ValidationError"),
    );
    await expect(announcements.discardAnnouncement(DOC, "5")).resolves.toEqual({
      ok: false,
      code: "invalid",
      fields: { _form: "neverPublished" },
    });
  });

  it("maps a lost class (the cms's 403 on PUT, 404 on a custom action) to forbidden and notFound", async () => {
    strapiMock.mockRejectedValueOnce(cmsError(403));
    await expect(
      announcements.saveAnnouncement({
        documentId: DOC,
        version: "5",
        status: "draft",
        values: announcement(),
        initial: announcement(),
      }),
    ).resolves.toEqual({ ok: false, code: "forbidden" });
    strapiMock.mockRejectedValueOnce(cmsError(404));
    await expect(announcements.publishAnnouncement(DOC, "5")).resolves.toEqual({
      ok: false,
      code: "notFound",
    });
  });

  it("without a department authors nothing (§N1)", async () => {
    viewerRef.current = viewer("department_head", null);
    await expect(
      announcements.saveAnnouncement({ status: "draft", values: announcement() }),
    ).resolves.toEqual({ ok: false, code: "forbidden" });
    await expect(events.publishEvent(DOC, "5")).resolves.toEqual({ ok: false, code: "forbidden" });
    expect(strapiMock).not.toHaveBeenCalled();
  });
});

describe("polls (alwaysPublished)", () => {
  const poll = { ...emptyPollValues(), question: "Lunch?", options: ["Pizza", "Salad"] };

  it("creates without a status, publishing at once", async () => {
    await polls.savePoll({ values: poll });
    expect(call()).toMatchObject({ path: "/api/polls", method: "POST" });
    expect(call().headers).not.toHaveProperty("If-Match");
  });

  it("updates without a status, with If-Match; a voted poll never sends answers or anonymity", async () => {
    await polls.savePoll({
      documentId: DOC,
      version: "3",
      values: { ...poll, options: ["Pizza", "Soup"], anonymous: true, question: "Dinner?" },
      initial: poll,
      hasVotes: true,
    });
    expect(call()).toMatchObject({
      path: `/api/polls/${DOC}`,
      method: "PUT",
      headers: { "If-Match": '"3"' },
      body: { data: { question: "Dinner?" } },
    });
  });

  it("Close now sets closesAt to this instant", async () => {
    const before = Date.now();
    await polls.closePoll(DOC, "3");
    const { body, path, headers } = call();
    expect(path).toBe(`/api/polls/${DOC}`);
    expect(headers).toEqual({ "If-Match": '"3"' });
    const closesAt = Date.parse((body as { data: { closesAt: string } }).data.closesAt);
    expect(closesAt).toBeGreaterThanOrEqual(before);
    expect(closesAt).toBeLessThanOrEqual(Date.now());
  });

  it("deletes with If-Match", async () => {
    strapiMock.mockResolvedValue(undefined);
    await expect(polls.deletePoll(DOC, "3")).resolves.toEqual({ ok: true, data: null });
    expect(call()).toMatchObject({ path: `/api/polls/${DOC}`, method: "DELETE" });
  });
});
