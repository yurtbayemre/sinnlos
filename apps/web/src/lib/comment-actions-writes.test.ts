import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * The comment and reaction writes answer ActionResults (AC01): success, the
 * cms's specific refusals (400 for an unknown, invisible or unpublished
 * target; 403 for a stranger's delete; 404 for a comment that is gone), the
 * expired session's redirect propagating, and a network error as
 * "unavailable". No refresh(): the sections refetch themselves. strapi() and
 * the session are mocked; next/navigation is the real module.
 */
const strapiMock = vi.fn();

vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("@/lib/session", () => ({ getSession: async () => ({ user: { id: 7 } }) }));

const { addComment, deleteComment, toggleReaction } = await import("./comment-actions");

const target = { type: "announcement", documentId: "doc-a" } as const;

function signInRedirect(): unknown {
  try {
    redirect("/sign-in?expired=1");
  } catch (error) {
    return error;
  }
  throw new Error("redirect() did not throw");
}

const cmsError = (status: number, message: string) =>
  new StrapiError(
    status,
    "Error",
    JSON.stringify({ data: null, error: { status, name: "Error", message, details: {} } }),
  );

beforeEach(() => {
  strapiMock.mockReset();
  strapiMock.mockResolvedValue({ data: { id: 1 } });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const writes = [
  {
    name: "addComment",
    run: () => addComment(target, "Hello"),
    path: "/api/comments",
    method: "POST",
    refusal: cmsError(400, "Target not available for comments"),
    refused: "invalid",
  },
  {
    name: "deleteComment (a stranger's comment)",
    run: () => deleteComment(12),
    path: "/api/comments/12",
    method: "DELETE",
    refusal: cmsError(403, "Forbidden"),
    refused: "forbidden",
  },
  {
    name: "deleteComment (a comment that is gone)",
    run: () => deleteComment(12),
    path: "/api/comments/12",
    method: "DELETE",
    refusal: cmsError(404, "Not Found"),
    refused: "notFound",
  },
  {
    name: "toggleReaction",
    run: () => toggleReaction(target, "heart", true),
    path: "/api/reactions",
    method: "POST",
    refusal: cmsError(400, "Target not available for reactions"),
    refused: "invalid",
  },
] as const;

describe.each(writes)("$name", ({ run, path, method, refusal, refused }) => {
  it("sends one request and answers ok", async () => {
    await expect(run()).resolves.toEqual({ ok: true });
    expect(strapiMock).toHaveBeenCalledTimes(1);
    const [calledPath, init] = strapiMock.mock.calls[0] as [string, { method: string }];
    expect(calledPath).toBe(path);
    expect(init.method).toBe(method);
  });

  it(`answers the cms's refusal as ${refused}`, async () => {
    strapiMock.mockRejectedValue(refusal);
    await expect(run()).resolves.toEqual({ ok: false, code: refused });
  });

  it("lets strapi()'s 401 sign-in redirect propagate", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValue(redirectError);
    await expect(run()).rejects.toBe(redirectError);
  });

  it("answers a network error as unavailable", async () => {
    strapiMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(run()).resolves.toEqual({ ok: false, code: "unavailable" });
  });
});

describe("addComment", () => {
  it("sends the body and the documentId anchor", async () => {
    await addComment(target, "Hello");
    const [, init] = strapiMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      data: { body: "Hello", targetType: "announcement", targetDocumentId: "doc-a" },
    });
  });

  it("refuses a target without a usable anchor before any request", async () => {
    for (const documentId of [null, "", "  ", 7]) {
      await expect(
        addComment({ type: "announcement", documentId } as unknown as typeof target, "x"),
      ).resolves.toEqual({ ok: false, code: "invalid" });
    }
    expect(strapiMock).not.toHaveBeenCalled();
  });
});

describe("deleteComment", () => {
  it("refuses an id that is no positive integer before it becomes part of the path", async () => {
    for (const id of [0, -1, 1.5, Number.NaN, "3", "../users/me", null]) {
      await expect(deleteComment(id as unknown as number), String(id)).resolves.toEqual({
        ok: false,
        code: "invalid",
      });
    }
    expect(strapiMock).not.toHaveBeenCalled();
  });
});
