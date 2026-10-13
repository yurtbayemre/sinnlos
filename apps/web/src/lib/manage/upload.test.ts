import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCUMENT_MAX_BYTES, IMAGE_MAX_BYTES } from "@sinnlos/domain";
import type { Viewer } from "@/lib/viewer";

/**
 * The upload step of a document (decision 06 §L6, §E6; batch 16 plan 16C
 * item 2 and its tests; contract K14), against a mocked cms: the
 * multipart request (one `files` part, the session's JWT, no-store), the
 * early checks before any byte is sent, the capability, and the mapping of
 * every answer: exactly one file row is ok; zero or two rows `failed`; a
 * 400 hands `details.codes.file` to `fields.file`; 413 is `fileTooLarge`;
 * 401 with a session token redirects to sign-in like strapi() (a genuine
 * NEXT_REDIRECT, rethrown); 403 forbidden; a network error unavailable.
 */

const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();
const tokenRef: { current: string | null } = { current: "jwt-test" };
const viewerRef: { current: Viewer } = { current: null as unknown as Viewer };

vi.mock("@/lib/session", () => ({ getStrapiToken: async () => tokenRef.current }));
vi.mock("@/lib/config", () => ({
  STRAPI_URL: "http://cms.test",
  DEMO_MODE: false,
  mediaUrl: (url: string) => url,
}));
vi.mock("@/lib/viewer", () => ({ getViewer: async () => viewerRef.current }));
vi.mock("@/lib/roles", async (original) => {
  const roles = await original<typeof import("@/lib/roles")>();
  const { k8Capabilities } = await import("./k8-capabilities.test.helper");
  return { ...roles, capabilitiesFor: (role: string | null) => k8Capabilities(roles, role) };
});
vi.stubGlobal("fetch", fetchMock);

const { uploadDocumentFile } = await import("./upload");

const ENG = { id: 3, documentId: "deptengineering000000000", name: "Engineering", slug: "eng" };
const viewer = (role: string | null, department: Viewer["department"] = null): Viewer => ({
  id: 7,
  displayName: "Ada",
  role,
  department,
});

const ROW = {
  id: 41,
  documentId: "file00000000000000000041",
  name: "budget.xlsx",
  mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  size: 12.5,
  url: "/uploads/budget_ab12.xlsx",
};

/** A file of `size` bytes (sparse: only the size matters before the request). */
function fileOf(name: string, size: number): File {
  const file = new File(["x"], name);
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function formWith(...files: unknown[]): FormData {
  const form = new FormData();
  for (const file of files) form.append("file", file as Blob);
  return form;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const refusal = (status: number, details: Record<string, unknown> = {}) =>
  json(status, {
    data: null,
    error: { status, name: "ValidationError", message: "refused", details },
  });

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => json(201, [ROW]));
  tokenRef.current = "jwt-test";
  viewerRef.current = viewer("editor");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("the request", () => {
  it("sends one multipart `files` part with the session's JWT, no-store, and answers the row", async () => {
    const result = await uploadDocumentFile(formWith(fileOf("budget.xlsx", 2048)));
    expect(result).toEqual({
      ok: true,
      data: { id: 41, name: ROW.name, mime: ROW.mime, size: 12.5, url: ROW.url },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://cms.test/api/upload");
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(init.headers).toEqual({ Authorization: "Bearer jwt-test" });
    const body = init.body as FormData;
    expect([...body.keys()]).toEqual(["files"]);
    expect((body.get("files") as File).name).toBe("budget.xlsx");
  });

  it("accepts the five kinds of file at their caps: PDF and Office 20 MB, images 5 MB", async () => {
    for (const [name, size] of [
      ["report.pdf", DOCUMENT_MAX_BYTES],
      ["letter.docx", DOCUMENT_MAX_BYTES],
      ["budget.xlsx", DOCUMENT_MAX_BYTES],
      ["slides.pptx", DOCUMENT_MAX_BYTES],
      ["photo.JPG", IMAGE_MAX_BYTES],
      ["photo.jpeg", IMAGE_MAX_BYTES],
      ["chart.png", IMAGE_MAX_BYTES],
      ["chart.webp", IMAGE_MAX_BYTES],
    ] as const) {
      await expect(uploadDocumentFile(formWith(fileOf(name, size))), name).resolves.toMatchObject({
        ok: true,
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });
});

describe("refused before any byte is sent", () => {
  it.each([
    ["macros.xlsm", 1024, "fileType"],
    ["template.dotx", 1024, "fileType"],
    ["notes.txt", 1024, "fileType"],
    ["no-extension", 1024, "fileType"],
    ["empty.pdf", 0, "fileType"],
    ["big.pdf", DOCUMENT_MAX_BYTES + 1, "fileTooLarge"],
    ["big.xlsx", DOCUMENT_MAX_BYTES + 1, "fileTooLarge"],
    ["big.png", IMAGE_MAX_BYTES + 1, "fileTooLarge"],
  ] as const)("%s (%i bytes): %s", async (name, size, code) => {
    await expect(uploadDocumentFile(formWith(fileOf(name, size)))).resolves.toEqual({
      ok: false,
      code: "invalid",
      fields: { file: code },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("anything but exactly one file is `required`; no form at all is invalid", async () => {
    for (const form of [formWith(), formWith(fileOf("a.pdf", 1), fileOf("b.pdf", 1))]) {
      await expect(uploadDocumentFile(form)).resolves.toEqual({
        ok: false,
        code: "invalid",
        fields: { file: "required" },
      });
    }
    const text = new FormData();
    text.append("file", "not a file");
    await expect(uploadDocumentFile(text)).resolves.toMatchObject({ fields: { file: "required" } });
    await expect(uploadDocumentFile({ file: "x" })).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("needs documents create or edit: members, team leads and guests are forbidden", async () => {
    for (const role of ["member", "team_lead", "guest", null]) {
      viewerRef.current = viewer(role);
      await expect(uploadDocumentFile(formWith(fileOf("a.pdf", 10)))).resolves.toEqual({
        ok: false,
        code: "forbidden",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a department head uploads with a department, never without one (§N1)", async () => {
    viewerRef.current = viewer("department_head", null);
    await expect(uploadDocumentFile(formWith(fileOf("a.pptx", 10)))).resolves.toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    viewerRef.current = viewer("department_head", ENG);
    await expect(uploadDocumentFile(formWith(fileOf("a.pptx", 10)))).resolves.toMatchObject({
      ok: true,
    });
  });

  it("an unreadable viewer is unavailable; no session token sends nothing (forbidden)", async () => {
    viewerRef.current = { ...viewer("editor"), id: null };
    await expect(uploadDocumentFile(formWith(fileOf("a.pdf", 10)))).resolves.toEqual({
      ok: false,
      code: "unavailable",
    });
    viewerRef.current = viewer("editor");
    tokenRef.current = null;
    await expect(uploadDocumentFile(formWith(fileOf("a.pdf", 10)))).resolves.toEqual({
      ok: false,
      code: "forbidden",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the answer (K14)", () => {
  const upload = () => uploadDocumentFile(formWith(fileOf("budget.xlsx", 2048)));

  it("zero rows, two rows or a row without an id are `failed`, logged as an error", async () => {
    for (const answer of [[], [ROW, { ...ROW, id: 42 }], [{ ...ROW, id: "41" }], { data: ROW }]) {
      fetchMock.mockResolvedValueOnce(json(201, answer));
      await expect(upload()).resolves.toEqual({ ok: false, code: "failed" });
    }
    expect(console.error).toHaveBeenCalledTimes(4);
  });

  it.each(["fileType", "fileTooLarge"])(
    "a 400 with details.codes.file = %s is that field code",
    async (code) => {
      fetchMock.mockResolvedValueOnce(refusal(400, { keys: ["file"], codes: { file: code } }));
      await expect(upload()).resolves.toEqual({
        ok: false,
        code: "invalid",
        fields: { file: code },
      });
    },
  );

  it("a 400 for another key keeps it (the form shows it as an unshown refusal)", async () => {
    fetchMock.mockResolvedValueOnce(refusal(400, { keys: ["fileInfo"] }));
    await expect(upload()).resolves.toEqual({
      ok: false,
      code: "invalid",
      fields: { fileInfo: "invalid" },
    });
  });

  it("413 (the body parser's cap) is fileTooLarge on the file", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Payload Too Large", { status: 413 }));
    await expect(upload()).resolves.toEqual({
      ok: false,
      code: "invalid",
      fields: { file: "fileTooLarge" },
    });
  });

  it("403 (?id= or no grant) is forbidden; 5xx and 429 unavailable", async () => {
    fetchMock.mockResolvedValueOnce(refusal(403));
    await expect(upload()).resolves.toEqual({ ok: false, code: "forbidden" });
    fetchMock.mockResolvedValueOnce(refusal(502));
    await expect(upload()).resolves.toEqual({ ok: false, code: "unavailable" });
    fetchMock.mockResolvedValueOnce(refusal(429));
    await expect(upload()).resolves.toEqual({ ok: false, code: "unavailable" });
  });

  it("a network error is unavailable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(upload()).resolves.toEqual({ ok: false, code: "unavailable" });
  });

  it("401 with a session token redirects to sign-in like strapi(): rethrown, never a result", async () => {
    fetchMock.mockResolvedValueOnce(refusal(401));
    const error = await upload().then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect((error as { digest?: string })?.digest).toMatch(
      /^NEXT_REDIRECT;[a-z]+;\/sign-in\?expired=1;/,
    );
  });
});
