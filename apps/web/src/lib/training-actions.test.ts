import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * completeLesson answers an ActionResult (AC01):
 *   - success: one POST naming only the lesson by documentId (the cms takes
 *     the user from the JWT), then refresh() for the course pages and the
 *     dashboard banner;
 *   - a 400 (the cms's target rules: unknown, draft-only or invisible
 *     lesson, or already completed) is "invalid", without a refresh;
 *   - strapi()'s 401 sign-in redirect propagates as the same NEXT_REDIRECT;
 *   - a network error is "unavailable";
 *   - an argument that is no documentId never reaches the cms;
 *   - a quiz lesson's passing answers go with the POST, and the cms's
 *     refusal of them ("Quiz not passed", issue #70) is "quizFailed";
 *     answers that are no list of option indexes never reach the cms.
 */

const strapiMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("next/cache", () => ({ refresh: () => refreshMock() }));

const { completeLesson, checkLesson } = await import("./training-actions");

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
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("completeLesson", () => {
  it("posts the lesson by documentId, then refreshes", async () => {
    await expect(completeLesson(LESSON)).resolves.toEqual({ ok: true });
    expect(strapiMock).toHaveBeenCalledTimes(1);
    const [path, init] = strapiMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe("/api/lesson-progresses");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ data: { targetDocumentId: LESSON } });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("answers the cms's 400 as invalid and does not refresh", async () => {
    strapiMock.mockRejectedValue(
      new StrapiError(400, "Bad Request", '{"error":{"message":"Already completed"}}'),
    );
    await expect(completeLesson(LESSON)).resolves.toEqual({ ok: false, code: "invalid" });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("lets strapi()'s 401 sign-in redirect propagate", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValue(redirectError);
    await expect(completeLesson(LESSON)).rejects.toBe(redirectError);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("answers a network error as unavailable", async () => {
    strapiMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(completeLesson(LESSON)).resolves.toEqual({ ok: false, code: "unavailable" });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it.each(["", 7, null])("refuses %j before any request", async (lesson) => {
    await expect(completeLesson(lesson as unknown as string)).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("sends a quiz lesson's answers with the lesson", async () => {
    await expect(completeLesson(LESSON, [2, 0])).resolves.toEqual({ ok: true });
    const [, init] = strapiMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      data: { targetDocumentId: LESSON, answers: [2, 0] },
    });
  });

  it("answers the cms's quiz refusal as quizFailed, without a refresh", async () => {
    strapiMock.mockRejectedValue(
      new StrapiError(400, "Bad Request", '{"error":{"message":"Quiz not passed"}}'),
    );
    await expect(completeLesson(LESSON, [0, 0])).resolves.toEqual({
      ok: false,
      code: "quizFailed",
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("distinguishes invalid stored quiz content from a wrong answer without recording success", async () => {
    strapiMock.mockRejectedValue(
      new StrapiError(
        400,
        "Bad Request",
        JSON.stringify({
          error: { message: "Invalid quiz content", details: { code: "quizContentInvalid" } },
        }),
      ),
    );
    await expect(completeLesson(LESSON, [0, 0])).resolves.toEqual({
      ok: false,
      code: "quizContentInvalid",
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("keeps server failures as unavailable even if they carry the content error code", async () => {
    strapiMock.mockRejectedValue(
      new StrapiError(
        500,
        "Server Error",
        JSON.stringify({
          error: { details: { code: "quizContentInvalid" } },
        }),
      ),
    );
    await expect(completeLesson(LESSON, [0, 0])).resolves.toEqual({
      ok: false,
      code: "unavailable",
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("never sends answers that are no list of option indexes", async () => {
    for (const answers of [[-1], [1.5], ["1"], [null], "1,0", { 0: 1 }, Array(101).fill(0)]) {
      await expect(
        completeLesson(LESSON, answers as unknown as number[]),
        JSON.stringify(answers),
      ).resolves.toEqual({ ok: false, code: "invalid" });
    }
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("pins the quiz refusal the cms controller sends", () => {
    const controller = readFileSync(
      join(__dirname, "../../../cms/src/api/lesson-progress/controllers/lesson-progress.ts"),
      "utf8",
    );
    expect(controller).toContain('ctx.badRequest("Quiz not passed")');
  });
});

describe("checkLesson", () => {
  const id = "a".repeat(24);
  const answers = [{ questionIndex: 0, optionIndex: 1 }];

  it.each(["confirm", "quizGate", "exam"] as const)(
    "returns server %s feedback without completing or refreshing",
    async (completionMode) => {
      const data = {
        completionMode,
        passed: true,
        ...(completionMode === "exam" ? {} : { verdicts: [{ questionIndex: 0, correct: true }] }),
      };
      strapiMock.mockResolvedValue({ data });
      await expect(checkLesson(id, answers)).resolves.toEqual({ ok: true, data });
      expect(strapiMock).toHaveBeenCalledExactlyOnceWith(`/api/lessons/${id}/check`, {
        method: "POST",
        body: JSON.stringify({ data: { answers } }),
      });
      expect(refreshMock).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed identities and indexed answers before calling the CMS", async () => {
    await expect(checkLesson("bad/id", answers)).resolves.toEqual({ ok: false, code: "invalid" });
    for (const selections of [
      null,
      [0],
      [{ questionIndex: 0, optionIndex: 8 }],
      [...answers, ...answers],
      [{ ...answers[0], mode: "confirm" }],
    ]) {
      await expect(checkLesson(id, selections as unknown as typeof answers)).resolves.toEqual({
        ok: false,
        code: "invalid",
      });
    }
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, { message: "Quiz not passed" }, "quizFailed"],
    [400, { message: "Invalid quiz answers" }, "quizFailed"],
    [400, { details: { code: "quizContentInvalid" } }, "quizContentInvalid"],
    [404, {}, "notFound"],
    [500, { details: { code: "quizContentInvalid" } }, "unavailable"],
  ])("maps status %i and the shared quiz error without refreshing", async (status, error, code) => {
    strapiMock.mockRejectedValue(
      new StrapiError(status as number, "Error", JSON.stringify({ error })),
    );
    await expect(checkLesson(id, answers)).resolves.toEqual({ ok: false, code });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("keeps transport failures and session expiry from becoming feedback", async () => {
    strapiMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(checkLesson(id, answers)).resolves.toEqual({ ok: false, code: "unavailable" });
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValue(redirectError);
    await expect(checkLesson(id, answers)).rejects.toBe(redirectError);
  });
});
