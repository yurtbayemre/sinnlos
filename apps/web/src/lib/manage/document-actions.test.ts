import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCUMENT_DEPARTMENT_AUTHOR_FIELDS } from "@sinnlos/domain";
import { StrapiError } from "@/lib/strapi-error";
import type { Viewer } from "@/lib/viewer";
import { emptyDocumentValues, type DocumentValues } from "./values";

/**
 * The document actions of /manage on AC01 against the K7 HTTP contract
 * (decision 06 §B3, §L3, §L6, §N2; batch 16 plan 16C tests "per action"
 * and "the department-author documents form"), strapi() mocked: the
 * request of each intent, the file as a row id (sent only when it changed,
 * and the same id again on a conflict's Overwrite: the save never uploads),
 * the department author's pinned department and missing schedule and
 * delete, and the mapping of every answer.
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

const documents = await import("./document-actions");

const ENG = { id: 3, documentId: "deptengineering000000000", name: "Engineering", slug: "eng" };
const SALES = "deptsales000000000000000";
const DOC = "docu00000000000000000001";
const viewer = (role: string | null, department: Viewer["department"] = null): Viewer => ({
  id: 7,
  displayName: "Ada",
  role,
  department,
});
const EDITOR = viewer("editor");
const HEAD = viewer("department_head", ENG);

const STORED = {
  id: 40,
  name: "old.pdf",
  mime: "application/pdf",
  size: 10,
  url: "/uploads/old.pdf",
};
const UPLOADED = {
  id: 42,
  name: "new.xlsx",
  mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  size: 12,
  url: "/uploads/new.xlsx",
};

const values = (patch: Partial<DocumentValues> = {}): DocumentValues => ({
  ...emptyDocumentValues(),
  title: "Travel policy",
  category: "policy",
  ...patch,
});

const dto = (patch: Record<string, unknown> = {}) => ({
  data: { documentId: DOC, version: "5", status: "draft", publishedAt: null, ...patch },
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
    body: init?.body ? (JSON.parse(init.body) as { data: Record<string, unknown> }) : undefined,
  };
}

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

describe("saves", () => {
  it("creates a draft with the uploaded file's id: POST ?status=draft, no If-Match", async () => {
    await expect(
      documents.saveDocument({
        status: "draft",
        values: values({ description: "For trips.", file: UPLOADED }),
      }),
    ).resolves.toEqual({ ok: true, data: dto().data });
    const sent = call();
    expect(sent.path).toBe("/api/documents?status=draft");
    expect(sent.method).toBe("POST");
    expect(sent.headers).not.toHaveProperty("If-Match");
    expect(sent.body).toEqual({
      data: {
        title: "Travel policy",
        description: "For trips.",
        category: "policy",
        departments: [],
        file: 42,
        requiresAck: false,
      },
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("a moderator's update sends a changed read confirmation alone (v0.20)", async () => {
    const initial = values();
    await documents.saveDocument({
      documentId: DOC,
      version: "5",
      status: "draft",
      values: { ...initial, requiresAck: true },
      initial,
    });
    expect(call().body).toEqual({ data: { requiresAck: true } });
  });

  it("a create without a file sends file: null", async () => {
    await documents.saveDocument({ status: "published", values: values() });
    expect(call().path).toBe("/api/documents?status=published");
    expect(call().body?.data.file).toBeNull();
  });

  it("replaces the file: PUT with If-Match and only the new id", async () => {
    const initial = values({ file: STORED });
    await documents.saveDocument({
      documentId: DOC,
      version: "5",
      status: "draft",
      values: { ...initial, file: UPLOADED },
      initial,
    });
    const sent = call();
    expect(sent.path).toBe(`/api/documents/${DOC}?status=draft`);
    expect(sent.method).toBe("PUT");
    expect(sent.headers).toEqual({ "If-Match": '"5"' });
    expect(sent.body).toEqual({ data: { file: 42 } });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("never sends an untouched file (another author's, a legacy one)", async () => {
    const initial = values({ file: STORED });
    await documents.saveDocument({
      documentId: DOC,
      version: "5",
      status: "draft",
      values: { ...initial, title: "Travel policy 2027" },
      initial,
    });
    expect(call().body).toEqual({ data: { title: "Travel policy 2027" } });
  });

  it("a conflict's Overwrite sends the same file id with the current version: nothing is uploaded again", async () => {
    const initial = values({ file: STORED });
    const input = {
      documentId: DOC,
      status: "draft",
      values: { ...initial, file: UPLOADED },
      initial,
    };
    strapiMock.mockRejectedValueOnce(cmsError(412, { current: 9 }));
    await expect(documents.saveDocument({ ...input, version: "5" })).resolves.toEqual({
      ok: false,
      code: "conflict",
      version: "9",
    });
    await expect(documents.saveDocument({ ...input, version: "9" })).resolves.toMatchObject({
      ok: true,
    });
    expect(strapiMock).toHaveBeenCalledTimes(2);
    expect(call(1).headers).toEqual({ "If-Match": '"9"' });
    expect(call(1).body).toEqual(call(0).body);
    expect(strapiMock.mock.calls.some(([path]) => String(path).includes("/upload"))).toBe(false);
  });

  it("maps a 400 on the file (a foreign or taken upload) to fields.file", async () => {
    strapiMock.mockRejectedValue(cmsError(400, { keys: ["file"] }));
    await expect(
      documents.saveDocument({ status: "draft", values: values({ file: UPLOADED }) }),
    ).resolves.toEqual({ ok: false, code: "invalid", fields: { file: "invalid" } });
  });

  it("428 is failed (logged), a network error unavailable, the sign-in redirect rethrown", async () => {
    const update = {
      documentId: DOC,
      version: "5",
      status: "draft",
      values: values({ title: "B" }),
      initial: values(),
    };
    strapiMock.mockRejectedValueOnce(cmsError(428));
    await expect(documents.saveDocument(update)).resolves.toEqual({ ok: false, code: "failed" });
    expect(console.error).toHaveBeenCalled();
    strapiMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(documents.saveDocument(update)).resolves.toEqual({
      ok: false,
      code: "unavailable",
    });
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValueOnce(redirectError);
    await expect(documents.saveDocument(update)).rejects.toBe(redirectError);
  });

  it("refuses locally: a blank title, a category the schema does not know", async () => {
    await expect(
      documents.saveDocument({ status: "draft", values: values({ title: " ", category: "memo" }) }),
    ).resolves.toEqual({
      ok: false,
      code: "invalid",
      fields: { title: "required", category: "invalid" },
    });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("a moderator schedules both ends (publishAt, unpublishAt) with status=draft", async () => {
    await documents.saveDocument({
      status: "draft",
      values: values(),
      schedule: {
        publishDate: "2030-01-02",
        publishTime: "08:00",
        unpublishDate: "2030-02-01",
        unpublishTime: "08:00",
      },
    });
    expect(call().body?.data).toMatchObject({
      publishAt: "2030-01-02T07:00:00.000Z",
      unpublishAt: "2030-02-01T07:00:00.000Z",
    });
  });
});

describe("a department author (amendment 1, §N2)", () => {
  beforeEach(() => {
    viewerRef.current = HEAD;
  });

  it("creates with their department pinned, whatever the form held, and never a moderator-only key", async () => {
    await documents.saveDocument({
      status: "published",
      values: values({ departments: [SALES], file: UPLOADED, requiresAck: true }),
    });
    const data = call().body?.data ?? {};
    expect(data.departments).toEqual([ENG.documentId]);
    // The read confirmation is a moderator field (v0.20).
    expect(data).not.toHaveProperty("requiresAck");
    expect(
      Object.keys(data).filter((key) => !DOCUMENT_DEPARTMENT_AUTHOR_FIELDS.includes(key as never)),
    ).toEqual([]);
    expect(data).not.toHaveProperty("publishAt");
    expect(data).not.toHaveProperty("unpublishAt");
  });

  it("an update leaves the targeting out; a crafted change still sends only their department", async () => {
    const initial = values({ departments: [ENG.documentId] });
    await documents.saveDocument({
      documentId: DOC,
      version: "5",
      status: "draft",
      values: { ...initial, title: "New" },
      initial,
    });
    expect(call(0).body).toEqual({ data: { title: "New" } });
    await documents.saveDocument({
      documentId: DOC,
      version: "5",
      status: "draft",
      values: { ...initial, departments: [SALES] },
      initial,
    });
    expect(call(1).body).toEqual({ data: { departments: [ENG.documentId] } });
  });

  it("may neither schedule nor delete: forbidden before any request", async () => {
    await expect(
      documents.saveDocument({
        status: "draft",
        values: values(),
        schedule: {
          publishDate: "2030-01-02",
          publishTime: "08:00",
          unpublishDate: "",
          unpublishTime: "",
        },
      }),
    ).resolves.toEqual({ ok: false, code: "forbidden" });
    await expect(documents.deleteDocument(DOC, "5")).resolves.toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("discards through the custom action; without a published version the cms answers neverPublished", async () => {
    strapiMock.mockRejectedValueOnce(
      cmsError(400, { keys: ["_form"], codes: { _form: "neverPublished" } }),
    );
    await expect(documents.discardDocument(DOC, "5")).resolves.toEqual({
      ok: false,
      code: "invalid",
      fields: { _form: "neverPublished" },
    });
    expect(call().path).toBe(`/api/documents/${DOC}/discard-draft`);
    expect(call().headers).toEqual({ "If-Match": '"5"' });
  });

  it("without a department authors nothing (§N1)", async () => {
    viewerRef.current = viewer("department_head", null);
    await expect(documents.saveDocument({ status: "draft", values: values() })).resolves.toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(strapiMock).not.toHaveBeenCalled();
  });
});

describe("transitions", () => {
  it.each([
    ["publishDocument", "POST", "publish"],
    ["unpublishDocument", "POST", "unpublish"],
    ["discardDocument", "POST", "discard-draft"],
  ] as const)("%s: %s …/%s with If-Match, then a refresh", async (name, method, suffix) => {
    await documents[name](DOC, "5");
    expect(call().path).toBe(`/api/documents/${DOC}/${suffix}`);
    expect(call().method).toBe(method);
    expect(call().headers).toEqual({ "If-Match": '"5"' });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("deleteDocument: DELETE with If-Match, no refresh (the form navigates)", async () => {
    strapiMock.mockResolvedValue(undefined);
    await expect(documents.deleteDocument(DOC, "5")).resolves.toEqual({ ok: true, data: null });
    expect(call().method).toBe("DELETE");
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("refuses a malformed reference before any request", async () => {
    await expect(documents.publishDocument("../users", "5")).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    await expect(documents.publishDocument(DOC, "W/5")).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("members and team leads are forbidden", async () => {
    for (const role of ["member", "team_lead", "guest"]) {
      viewerRef.current = viewer(role);
      await expect(documents.unpublishDocument(DOC, "5")).resolves.toEqual({
        ok: false,
        code: "forbidden",
      });
    }
    expect(strapiMock).not.toHaveBeenCalled();
  });
});
