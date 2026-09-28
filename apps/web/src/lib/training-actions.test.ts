import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * completeLesson characterisation (S09). The action has no catch:
 *   - success: one POST naming only the lesson by documentId (the cms takes
 *     the user from the JWT), then refresh() for the course pages and the
 *     dashboard banner;
 *   - a 400 (the cms's target rules: unknown, draft-only or invisible
 *     lesson) rejects with the StrapiError and does not refresh;
 *   - strapi()'s 401 sign-in redirect propagates as the same NEXT_REDIRECT.
 */

const strapiMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("next/cache", () => ({ refresh: () => refreshMock() }));

const { completeLesson } = await import("./training-actions");

const LESSON = "k3m9x0000000000000000000";

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

describe("completeLesson", () => {
  it("posts the lesson by documentId, then refreshes", async () => {
    await expect(completeLesson(LESSON)).resolves.toBeUndefined();
    expect(strapiMock).toHaveBeenCalledTimes(1);
    const [path, init] = strapiMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe("/api/lesson-progresses");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ data: { targetDocumentId: LESSON } });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("rejects with the cms's 400 and does not refresh", async () => {
    const error = new StrapiError(
      400,
      "Bad Request",
      '{"error":{"message":"Lesson not available"}}',
    );
    strapiMock.mockRejectedValue(error);
    await expect(completeLesson(LESSON)).rejects.toBe(error);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("lets strapi()'s 401 sign-in redirect propagate", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValue(redirectError);
    await expect(completeLesson(LESSON)).rejects.toBe(redirectError);
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
