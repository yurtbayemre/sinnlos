import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * sendUpload (v0.30): the raw multipart fetch follows strapi()'s rules — a
 * bounded wait, the caller's JWT, no-store, a 401 for the sent JWT goes to
 * the sign-in page. `@/lib/session` and `@/lib/config` are mocked, fetch is
 * stubbed; next/navigation is the real one.
 */
const tokenMock = vi.fn<() => Promise<string | null>>();
const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();

vi.mock("@/lib/session", () => ({ getStrapiToken: () => tokenMock() }));
vi.mock("@/lib/config", () => ({ STRAPI_URL: "http://cms.test" }));
vi.stubGlobal("fetch", fetchMock);

const { UPLOAD_FIELD, UPLOAD_TIMEOUT_MS, sendUpload } = await import("./upload");

const file = () => new File(["x"], "a.pdf", { type: "application/pdf" });
const digestOf = (error: unknown) => String((error as { digest?: unknown }).digest);

beforeEach(() => {
  tokenMock.mockReset();
  tokenMock.mockResolvedValue("jwt-1");
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify([{ id: 5 }]), { status: 201 }));
});

describe("sendUpload", () => {
  it("posts the file with the caller's JWT, uncached and bounded, and parses the answer", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await expect(sendUpload(file())).resolves.toEqual([{ id: 5 }]);
      expect(timeout).toHaveBeenCalledWith(UPLOAD_TIMEOUT_MS);
    } finally {
      timeout.mockRestore();
    }
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://cms.test/api/upload");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer jwt-1");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.body as FormData).getAll(UPLOAD_FIELD)).toHaveLength(1);
  });

  it("sends a revoked session to the sign-in page", async () => {
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const error = await sendUpload(file()).catch((e: unknown) => e);
    let expected: unknown;
    try {
      redirect("/sign-in?expired=1");
    } catch (e) {
      expected = e;
    }
    expect(digestOf(error)).toBe(digestOf(expected));
  });

  it("sends nothing without a session token", async () => {
    tokenMock.mockResolvedValue(null);
    await expect(sendUpload(file())).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
