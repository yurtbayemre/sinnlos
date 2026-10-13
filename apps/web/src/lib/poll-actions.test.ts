import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * votePoll addresses the poll by documentId (DA01) and carries the option
 * text the card showed (the cms refuses the vote when an edit moved it,
 * which answers its own code, pollOptionsChanged); a bad reference or
 * option text is "invalid" before any request. It answers an ActionResult
 * (AC01), and an expired session (strapi()'s redirect on 401) escapes the
 * action instead of becoming "failed" (FX47). Polls are created in /manage
 * since batch 15 (lib/manage/poll-actions.ts, tested in
 * lib/manage/actions.test.ts); the old createPoll is gone.
 *
 * `@/lib/strapi` and `next/cache` are mocked: only the request the action
 * builds matters here. `next/navigation` is the real module, so the
 * redirect error and unstable_rethrow are Next's own.
 */
const strapiMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("next/cache", () => ({ refresh: () => refreshMock() }));

const { votePoll } = await import("./poll-actions");
const { redirect } = await import("next/navigation");

/** The error Next's redirect() throws (NEXT_REDIRECT digest). */
function captureRedirect(url: string): unknown {
  try {
    redirect(url);
  } catch (e) {
    return e;
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

/** A Strapi error envelope as ctx.badRequest()/forbidden() send it. */
const cmsError = (status: number, message: string) =>
  new StrapiError(
    status,
    "Error",
    JSON.stringify({
      data: null,
      error: { status, name: status === 400 ? "BadRequestError" : "Error", message, details: {} },
    }),
  );

describe("votePoll", () => {
  it("posts the option to the custom vote route and refreshes the page", async () => {
    await expect(votePoll(4, 1)).resolves.toEqual({ ok: true });
    expect(strapiMock).toHaveBeenCalledWith("/api/polls/4/vote", {
      method: "POST",
      body: JSON.stringify({ optionIndex: 1 }),
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("addresses the poll by its documentId (DA01)", async () => {
    await votePoll("k3m9x0000000000000000001", 0);
    expect(strapiMock).toHaveBeenCalledWith("/api/polls/k3m9x0000000000000000001/vote", {
      method: "POST",
      body: JSON.stringify({ optionIndex: 0 }),
    });
  });

  it("sends the option text the card showed, so the cms can refuse a moved option", async () => {
    await votePoll("k3m9x0000000000000000001", 1, "Sushi");
    expect(strapiMock).toHaveBeenCalledWith("/api/polls/k3m9x0000000000000000001/vote", {
      method: "POST",
      body: JSON.stringify({ optionIndex: 1, option: "Sushi" }),
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an option that is not a string or is oversized, without a request", async () => {
    for (const option of [1, null, { text: "Sushi" }, "x".repeat(10_001)]) {
      await expect(
        votePoll("k3m9x0000000000000000001", 0, option as unknown as string),
        typeof option,
      ).resolves.toEqual({ ok: false, code: "invalid" });
    }
    expect(strapiMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
    // The longest text the action forwards.
    await votePoll("k3m9x0000000000000000001", 0, "x".repeat(10_000));
    expect(strapiMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a reference that is neither a documentId nor a row id, without a request", async () => {
    for (const ref of ["../polls", "1/vote", "abc", "0", "1.5", "", "K3M9X0000000000000000001"]) {
      await expect(votePoll(ref, 0), ref).resolves.toEqual({ ok: false, code: "invalid" });
    }
    for (const ref of [0, -1, 1.5, Number.NaN]) {
      await expect(votePoll(ref, 0), String(ref)).resolves.toEqual({
        ok: false,
        code: "invalid",
      });
    }
    expect(strapiMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("answers the stale-card refusal with its own code, pollOptionsChanged", async () => {
    strapiMock.mockRejectedValue(cmsError(400, "Poll options changed"));
    await expect(votePoll("k3m9x0000000000000000001", 1, "Sushi")).resolves.toEqual({
      ok: false,
      code: "pollOptionsChanged",
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it.each([
    ["already voted", cmsError(400, "Already voted"), "invalid"],
    ["a closed poll", cmsError(400, "Poll is closed"), "invalid"],
    ["outside the audience", cmsError(403, "Not in poll audience"), "forbidden"],
    ["an invisible poll", cmsError(404, "Not Found"), "notFound"],
    ["a network error", new TypeError("fetch failed"), "unavailable"],
  ])("answers %s as %s", async (_label, error, code) => {
    strapiMock.mockRejectedValue(error);
    await expect(votePoll("k3m9x0000000000000000001", 0, "Pizza")).resolves.toEqual({
      ok: false,
      code,
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("lets the expired-session redirect escape (NEXT_REDIRECT)", async () => {
    const expired = captureRedirect("/sign-in?expired=1");
    strapiMock.mockRejectedValue(expired);
    await expect(votePoll("k3m9x0000000000000000001", 0)).rejects.toBe(expired);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("pins the stale-card text the cms controller sends", () => {
    const controller = readFileSync(
      join(__dirname, "../../../cms/src/api/poll-vote/controllers/poll-vote.ts"),
      "utf8",
    );
    // The vote's refusal under the poll's lock (batch 15) answers it with
    // ctx.badRequest(message) after the transaction.
    expect(controller).toContain('{ kind: "badRequest", message: "Poll options changed" }');
    expect(controller).toContain("ctx.badRequest(outcome.message)");
  });
});
