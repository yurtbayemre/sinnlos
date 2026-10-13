import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WIKI_PAGE_ROW_EDIT_FIELDS, WIKI_PAGE_AUTHOR_CREATE_FIELDS } from "@sinnlos/domain";
import { StrapiError } from "@/lib/strapi-error";
import type { Viewer } from "@/lib/viewer";
import { emptyWikiPageValues, emptyWikiSpaceValues, type WikiPageValues } from "./wiki-values";

/**
 * The wiki's Server Actions on AC01 against the wiki HTTP contract
 * (decision 06 §J1, §J2, §L3; batch 16 plan 16C tests "per action" for
 * wiki spaces and wiki pages; contract K18), strapi() mocked: which route
 * each class takes (moderators the generic routes with their status; the
 * row classes the draft actions, and the generic route pinned to published
 * for "Save and publish"), the keys a class may send, If-Match, and the
 * mapping of every answer: success, 400 with fields (`parentCycle` on
 * `parent`, `_form: spaceNotEmpty`), 412 conflict with the version, 428
 * failed and logged, the 401 sign-in redirect rethrown, a network error
 * unavailable. The capabilities are batch 16's (K20: moderators may
 * unpublish once 16B grants it), mocked over this branch's lib/roles.ts.
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
  return {
    ...roles,
    capabilitiesFor: (role: string | null) => {
      const caps = k8Capabilities(roles, role);
      // K20 (lane 16B): wikiPages.unpublish for moderators with the grant.
      return {
        ...caps,
        wikiPages: { ...caps.wikiPages, unpublish: caps.wikiPages.edit === "any" },
      };
    },
  };
});

const pages = await import("./wiki-page-actions");
const spaces = await import("./wiki-space-actions");

const SPACE = "spce00000000000000000001";
const PAGE = "page00000000000000000001";
const PARENT = "page00000000000000000002";
const ENG = { id: 3, documentId: "deptengineering000000000", name: "Engineering", slug: "eng" };

const viewer = (role: string | null, department: Viewer["department"] = null): Viewer => ({
  id: 7,
  displayName: "Ada",
  role,
  department,
});

const page = (patch: Partial<WikiPageValues> = {}): WikiPageValues => ({
  ...emptyWikiPageValues(),
  title: "Laptop setup",
  ...patch,
});

const result = (patch: Record<string, unknown> = {}) => ({
  data: {
    documentId: PAGE,
    version: "5",
    status: "draft",
    publishedAt: null,
    slug: "laptop-setup",
    spaceSlug: "handbook",
    ...patch,
  },
});

function signInRedirect(): unknown {
  try {
    redirect("/sign-in?expired=1");
  } catch (error) {
    return error;
  }
  throw new Error("redirect() did not throw");
}

const cmsError = (status: number, details: Record<string, unknown> = {}) =>
  new StrapiError(
    status,
    "Error",
    JSON.stringify({ data: null, error: { status, name: "Error", message: "refused", details } }),
  );

function call(n = 0) {
  const [path, init] = strapiMock.mock.calls[n] as [
    string,
    { method?: string; headers?: Record<string, string>; body?: string },
  ];
  return {
    path,
    method: init?.method ?? "GET",
    headers: init?.headers ?? {},
    body: init?.body
      ? (JSON.parse(init.body) as Record<string, Record<string, unknown>>)
      : undefined,
  };
}

beforeEach(() => {
  strapiMock.mockReset().mockResolvedValue(result());
  refreshMock.mockReset();
  viewerRef.current = viewer("editor");
  vi.stubEnv("APP_TIME_ZONE", "Europe/Berlin");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("wiki pages: the route per class", () => {
  it("a moderator creates through the generic route with the status and every moderator key", async () => {
    await expect(
      pages.saveWikiPage({
        status: "draft",
        space: SPACE,
        values: page({ parent: PARENT, tags: "a, b, A", order: "3", department: ENG.documentId }),
      }),
    ).resolves.toEqual({ ok: true, data: result().data });
    const sent = call();
    expect(sent.path).toBe("/api/wiki-pages?status=draft");
    expect(sent.method).toBe("POST");
    expect(sent.headers).not.toHaveProperty("If-Match");
    expect(sent.body?.data).toEqual({
      title: "Laptop setup",
      summary: null,
      body: null,
      tags: ["a", "b"],
      tocEnabled: true,
      order: 3,
      space: SPACE,
      parent: PARENT,
      department: ENG.documentId,
      team: null,
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("a team lead's draft goes to createDraft (no status), with the author's keys only", async () => {
    viewerRef.current = viewer("team_lead");
    await pages.saveWikiPage({
      status: "draft",
      space: SPACE,
      values: page({ department: ENG.documentId, team: "teamx00000000000000000001" }),
    });
    const sent = call();
    expect(sent.path).toBe("/api/wiki-pages/drafts");
    expect(sent.method).toBe("POST");
    const keys = Object.keys(sent.body?.data ?? {});
    expect(keys.filter((key) => !WIKI_PAGE_AUTHOR_CREATE_FIELDS.includes(key as never))).toEqual(
      [],
    );
    expect(sent.body?.data).not.toHaveProperty("department");
    expect(sent.body?.data.space).toBe(SPACE);
  });

  it("a department head publishing a new page takes the generic create, pinned to published", async () => {
    viewerRef.current = viewer("department_head", ENG);
    await pages.saveWikiPage({ status: "published", space: SPACE, values: page() });
    expect(call().path).toBe("/api/wiki-pages?status=published");
  });

  it("a member (the page's author) saves a draft through saveDraft with If-Match", async () => {
    viewerRef.current = viewer("member");
    const initial = page();
    await pages.saveWikiPage({
      documentId: PAGE,
      version: "5",
      status: "draft",
      values: { ...initial, body: "New text", revisionSummary: "Typo" },
      initial,
    });
    const sent = call();
    expect(sent.path).toBe(`/api/wiki-pages/${PAGE}/draft`);
    expect(sent.method).toBe("PUT");
    expect(sent.headers).toEqual({ "If-Match": '"5"' });
    expect(sent.body).toEqual({ data: { body: "New text", revisionSummary: "Typo" } });
    expect(
      Object.keys(sent.body?.data ?? {}).every((key) =>
        WIKI_PAGE_ROW_EDIT_FIELDS.includes(key as never),
      ),
    ).toBe(true);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("a member's Save and publish takes the generic update with ?status=published", async () => {
    viewerRef.current = viewer("member");
    const initial = page();
    await pages.saveWikiPage({
      documentId: PAGE,
      version: "5",
      status: "published",
      values: { ...initial, title: "Laptop setup (2027)" },
      initial,
    });
    expect(call().path).toBe(`/api/wiki-pages/${PAGE}?status=published`);
    expect(call().method).toBe("PUT");
    expect(call().body).toEqual({ data: { title: "Laptop setup (2027)" } });
  });

  it("a moderator's update: PUT ?status=draft, the change note only when written", async () => {
    const initial = page();
    await pages.saveWikiPage({
      documentId: PAGE,
      version: "5",
      status: "draft",
      values: { ...initial, summary: "How to" },
      initial,
    });
    expect(call().path).toBe(`/api/wiki-pages/${PAGE}?status=draft`);
    expect(call().body).toEqual({ data: { summary: "How to" } });
  });

  it("a moderator schedules (publishAt); every other class may not", async () => {
    const schedule = {
      publishDate: "2030-01-02",
      publishTime: "08:00",
      unpublishDate: "",
      unpublishTime: "",
    };
    await pages.saveWikiPage({ status: "draft", space: SPACE, values: page(), schedule });
    expect(call().body?.data.publishAt).toBe("2030-01-02T07:00:00.000Z");
    viewerRef.current = viewer("team_lead");
    await expect(
      pages.saveWikiPage({ status: "draft", space: SPACE, values: page(), schedule }),
    ).resolves.toEqual({ ok: false, code: "forbidden" });
    expect(strapiMock).toHaveBeenCalledTimes(1);
  });

  it("a member cannot create (no create grant); a guest edits nothing", async () => {
    viewerRef.current = viewer("member");
    await expect(
      pages.saveWikiPage({ status: "draft", space: SPACE, values: page() }),
    ).resolves.toEqual({ ok: false, code: "forbidden" });
    viewerRef.current = viewer("guest");
    await expect(
      pages.saveWikiPage({
        documentId: PAGE,
        version: "5",
        status: "draft",
        values: page(),
        initial: page(),
      }),
    ).resolves.toEqual({ ok: false, code: "forbidden" });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("refuses locally: no space on a create, a bad status, a blank title, too many tags", async () => {
    await expect(pages.saveWikiPage({ status: "draft", values: page() })).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    await expect(
      pages.saveWikiPage({ status: "maybe", space: SPACE, values: page() }),
    ).resolves.toEqual({ ok: false, code: "invalid" });
    const tags = Array.from({ length: 21 }, (_, i) => `tag${i}`).join(",");
    await expect(
      pages.saveWikiPage({ status: "draft", space: SPACE, values: page({ title: " ", tags }) }),
    ).resolves.toEqual({
      ok: false,
      code: "invalid",
      fields: { title: "required", tags: "invalid" },
    });
    expect(strapiMock).not.toHaveBeenCalled();
  });
});

describe("wiki pages: the answers", () => {
  const update = {
    documentId: PAGE,
    version: "5",
    status: "draft",
    values: page({ parent: PARENT }),
    initial: page(),
  };

  it("a parent loop is parentCycle on the parent", async () => {
    strapiMock.mockRejectedValueOnce(
      cmsError(400, { keys: ["parent"], codes: { parent: "parentCycle" } }),
    );
    await expect(pages.saveWikiPage(update)).resolves.toEqual({
      ok: false,
      code: "invalid",
      fields: { parent: "parentCycle" },
    });
  });

  it("412 is conflict with the current version; 428 failed and logged", async () => {
    strapiMock.mockRejectedValueOnce(cmsError(412, { current: "8" }));
    await expect(pages.saveWikiPage(update)).resolves.toEqual({
      ok: false,
      code: "conflict",
      version: "8",
    });
    strapiMock.mockRejectedValueOnce(cmsError(428));
    await expect(pages.saveWikiPage(update)).resolves.toEqual({ ok: false, code: "failed" });
    expect(console.error).toHaveBeenCalled();
  });

  it("404 (no class on the page) is notFound; a network error unavailable", async () => {
    strapiMock.mockRejectedValueOnce(cmsError(404));
    await expect(pages.saveWikiPage(update)).resolves.toEqual({ ok: false, code: "notFound" });
    strapiMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(pages.saveWikiPage(update)).resolves.toEqual({
      ok: false,
      code: "unavailable",
    });
  });

  it("rethrows the sign-in redirect", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValueOnce(redirectError);
    await expect(pages.saveWikiPage(update)).rejects.toBe(redirectError);
  });
});

describe("wiki pages: transitions and restore", () => {
  it.each([
    ["publishWikiPage", "publish"],
    ["discardWikiPage", "discard-draft"],
    ["unpublishWikiPage", "unpublish"],
  ] as const)("%s: POST …/%s with If-Match", async (name, suffix) => {
    await pages[name](PAGE, "5");
    expect(call().path).toBe(`/api/wiki-pages/${PAGE}/${suffix}`);
    expect(call().method).toBe("POST");
    expect(call().headers).toEqual({ "If-Match": '"5"' });
  });

  it("a discard that removed a never-published page answers null (the form navigates)", async () => {
    strapiMock.mockResolvedValueOnce(undefined);
    await expect(pages.discardWikiPage(PAGE, "5")).resolves.toEqual({ ok: true, data: null });
  });

  it("delete: DELETE with If-Match, moderators only", async () => {
    strapiMock.mockResolvedValueOnce(undefined);
    await expect(pages.deleteWikiPage(PAGE, "5")).resolves.toEqual({ ok: true, data: null });
    expect(call().method).toBe("DELETE");
    expect(refreshMock).not.toHaveBeenCalled();
    viewerRef.current = viewer("member");
    await expect(pages.deleteWikiPage(PAGE, "5")).resolves.toEqual({
      ok: false,
      code: "forbidden",
    });
    await expect(pages.unpublishWikiPage(PAGE, "5")).resolves.toEqual({
      ok: false,
      code: "forbidden",
    });
    // The row classes publish and discard.
    await pages.publishWikiPage(PAGE, "5");
    expect(strapiMock).toHaveBeenCalledTimes(2);
  });

  it("restore: POST …/restore {revisionId} with If-Match; another page's revision is notFound", async () => {
    viewerRef.current = viewer("member");
    await pages.restoreWikiRevision(PAGE, "5", 41);
    expect(call().path).toBe(`/api/wiki-pages/${PAGE}/restore`);
    expect(call().method).toBe("POST");
    expect(call().headers).toEqual({ "If-Match": '"5"' });
    expect(call().body).toEqual({ revisionId: 41 });
    strapiMock.mockRejectedValueOnce(cmsError(404));
    await expect(pages.restoreWikiRevision(PAGE, "5", 42)).resolves.toEqual({
      ok: false,
      code: "notFound",
    });
  });

  it("refuses a malformed reference or revision id before any request", async () => {
    for (const [doc, version, revision] of [
      ["../x", "5", 1],
      [PAGE, "W/5", 1],
      [PAGE, "5", 0],
      [PAGE, "5", "41"],
      [PAGE, "5", 1.5],
    ] as const) {
      await expect(pages.restoreWikiRevision(doc, version, revision)).resolves.toEqual({
        ok: false,
        code: "invalid",
      });
    }
    expect(strapiMock).not.toHaveBeenCalled();
  });
});

describe("wiki spaces (moderators)", () => {
  const space = (patch: Record<string, unknown> = {}) => ({
    ...emptyWikiSpaceValues(),
    name: "Handbook",
    ...patch,
  });

  it("creates: POST without a status, the visibility with its target group", async () => {
    strapiMock.mockResolvedValueOnce({
      data: { documentId: SPACE, version: "1", slug: "handbook" },
    });
    await spaces.saveWikiSpace({
      values: space({
        visibility: "department",
        department: ENG.documentId,
        allowedRoles: ["member"],
      }),
    });
    const sent = call();
    expect(sent.path).toBe("/api/wiki-spaces");
    expect(sent.method).toBe("POST");
    expect(sent.body?.data).toEqual({
      name: "Handbook",
      icon: null,
      description: null,
      visibility: "department",
      allowedRoles: [],
      department: ENG.documentId,
      team: null,
    });
  });

  it("refuses a visibility without its target locally (visibilityTarget)", async () => {
    await expect(
      spaces.saveWikiSpace({ values: space({ visibility: "role", allowedRoles: [] }) }),
    ).resolves.toEqual({
      ok: false,
      code: "invalid",
      fields: { allowedRoles: "visibilityTarget" },
    });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("updates with If-Match, only what changed", async () => {
    const initial = space({ icon: "BookOpen" });
    await spaces.saveWikiSpace({
      documentId: SPACE,
      version: "4",
      values: { ...initial, description: "All about us" },
      initial,
    });
    expect(call().path).toBe(`/api/wiki-spaces/${SPACE}`);
    expect(call().method).toBe("PUT");
    expect(call().headers).toEqual({ "If-Match": '"4"' });
    expect(call().body).toEqual({ data: { description: "All about us" } });
  });

  it("never makes a space whose target is gone public without the confirmation", async () => {
    const initial = space({ visibility: "department", department: "" });
    strapiMock.mockResolvedValueOnce({
      data: { documentId: SPACE, version: "4", needsRetarget: true },
    });
    await expect(
      spaces.saveWikiSpace({
        documentId: SPACE,
        version: "4",
        values: { ...initial, visibility: "public" },
        initial,
      }),
    ).resolves.toEqual({ ok: false, code: "invalid", fields: { visibility: "confirmAudience" } });
    expect(strapiMock).toHaveBeenCalledTimes(1);
    expect(call().path).toBe(`/api/wiki-spaces/${SPACE}/editable`);
    // With the confirmation it is sent, without the extra read.
    strapiMock.mockClear();
    await spaces.saveWikiSpace({
      documentId: SPACE,
      version: "4",
      values: { ...initial, visibility: "public" },
      initial,
      retarget: true,
    });
    expect(strapiMock).toHaveBeenCalledTimes(1);
    expect(call().method).toBe("PUT");
  });

  it("a space with pages: delete answers _form spaceNotEmpty", async () => {
    strapiMock.mockRejectedValueOnce(
      cmsError(400, { keys: ["_form"], codes: { _form: "spaceNotEmpty" } }),
    );
    await expect(spaces.deleteWikiSpace(SPACE, "4")).resolves.toEqual({
      ok: false,
      code: "invalid",
      fields: { _form: "spaceNotEmpty" },
    });
    expect(call().method).toBe("DELETE");
    expect(call().headers).toEqual({ "If-Match": '"4"' });
  });

  it("department heads and members are forbidden, before any request", async () => {
    for (const current of [viewer("department_head", ENG), viewer("member"), viewer("team_lead")]) {
      viewerRef.current = current;
      await expect(spaces.saveWikiSpace({ values: space() })).resolves.toEqual({
        ok: false,
        code: "forbidden",
      });
      await expect(spaces.deleteWikiSpace(SPACE, "4")).resolves.toEqual({
        ok: false,
        code: "forbidden",
      });
    }
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("412 on a space save is conflict with the version", async () => {
    strapiMock.mockRejectedValueOnce(cmsError(412, { current: 6 }));
    await expect(
      spaces.saveWikiSpace({
        documentId: SPACE,
        version: "4",
        values: space({ name: "Handbook 2" }),
        initial: space(),
      }),
    ).resolves.toEqual({ ok: false, code: "conflict", version: "6" });
  });
});
