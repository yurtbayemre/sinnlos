import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * createPoll (decision 02): the payload carries the explicit `audience`
 * flag ("departments" when departments are chosen, "all" otherwise), only
 * positive integer department ids reach the CMS, a role that may not
 * create polls is turned away before any write, and the action no longer
 * refreshes or tags a cache (D-DC01; the form navigates to /polls itself).
 * Guest access (owner decision 2026-09-27): `visibleToGuests` and
 * `guestsCanVote` are always sent as strict booleans, hidden by default,
 * guest voting only together with visibility.
 *
 * An expired session (strapi()'s redirect on 401) escapes the action
 * instead of becoming "failed" (FX47).
 *
 * votePoll addresses the poll by documentId (DA01) and carries the option
 * text the card showed (the cms refuses the vote when an edit moved it,
 * which answers its own code, pollOptionsChanged); a bad reference or
 * option text is "invalid" before any request. Both answer ActionResults
 * (AC01).
 *
 * `@/lib/strapi`, `@/lib/viewer` and `next/cache` are mocked: only the
 * request the action builds matters here. `next/navigation` is the real
 * module, so the redirect error and unstable_rethrow are Next's own.
 */
const strapiMock = vi.fn();
const viewerMock = vi.fn();
const refreshMock = vi.fn();
const updateTagMock = vi.fn();
const revalidateTagMock = vi.fn();

vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("@/lib/viewer", () => ({ getViewer: () => viewerMock() }));
vi.mock("next/cache", () => ({
  refresh: () => refreshMock(),
  updateTag: (...args: unknown[]) => updateTagMock(...args),
  revalidateTag: (...args: unknown[]) => revalidateTagMock(...args),
}));

const { createPoll, votePoll } = await import("./poll-actions");
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

const input = (departmentIds: number[]) => ({
  question: "Pizza or sushi?",
  options: ["Pizza", "Sushi"],
  closesAt: "",
  anonymous: false,
  departmentIds,
});

/** The `data` object of the one POST createPoll sent. */
function sentData(): Record<string, unknown> {
  expect(strapiMock).toHaveBeenCalledTimes(1);
  const [path, init] = strapiMock.mock.calls[0] as [string, { method: string; body: string }];
  expect(path).toBe("/api/polls?status=published");
  expect(init.method).toBe("POST");
  return (JSON.parse(init.body) as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  strapiMock.mockReset();
  strapiMock.mockResolvedValue({ data: { id: 1 } });
  viewerMock.mockReset();
  viewerMock.mockResolvedValue({ id: 1, displayName: "Ed", role: "editor", department: null });
  refreshMock.mockReset();
  updateTagMock.mockReset();
  revalidateTagMock.mockReset();
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

describe("createPoll", () => {
  it("sends audience 'departments' with the chosen department ids", async () => {
    await expect(createPoll(input([3, 5]))).resolves.toEqual({ ok: true });
    expect(sentData()).toMatchObject({ audience: "departments", departments: [3, 5] });
  });

  it("sends audience 'all' without departments", async () => {
    await createPoll(input([]));
    expect(sentData()).toMatchObject({ audience: "all", departments: [] });
  });

  it("drops non-integer, non-positive and duplicate department ids", async () => {
    await createPoll(input([2, 0, -4, 1.5, Number.NaN, 2, 7]));
    expect(sentData()).toMatchObject({ audience: "departments", departments: [2, 7] });
  });

  it("falls back to audience 'all' when no usable id is left", async () => {
    await createPoll(input([0, -1, 2.5]));
    expect(sentData()).toMatchObject({ audience: "all", departments: [] });
  });

  it("keeps the other fields as before", async () => {
    await createPoll({ ...input([]), anonymous: true, options: [" A ", "B", "A", ""] });
    expect(sentData()).toEqual({
      question: "Pizza or sushi?",
      options: ["A", "B"],
      closesAt: null,
      anonymous: true,
      audience: "all",
      departments: [],
      visibleToGuests: false,
      guestsCanVote: false,
    });
  });

  it("sends the poll hidden from guests unless the author opened it", async () => {
    await createPoll(input([]));
    expect(sentData()).toMatchObject({ visibleToGuests: false, guestsCanVote: false });
  });

  it("sends both guest switches as given when the poll is visible to guests", async () => {
    await createPoll({ ...input([3]), visibleToGuests: true, guestsCanVote: false });
    expect(sentData()).toMatchObject({ visibleToGuests: true, guestsCanVote: false });
    strapiMock.mockClear();
    await createPoll({ ...input([3]), visibleToGuests: true, guestsCanVote: true });
    expect(sentData()).toMatchObject({ visibleToGuests: true, guestsCanVote: true });
  });

  it("forces guest voting off when the poll is not visible to guests", async () => {
    await createPoll({ ...input([]), visibleToGuests: false, guestsCanVote: true });
    expect(sentData()).toMatchObject({ visibleToGuests: false, guestsCanVote: false });
  });

  it("sends strict booleans only, whatever a crafted call passes", async () => {
    const crafted = {
      ...input([]),
      visibleToGuests: "true",
      guestsCanVote: 1,
    } as unknown as Parameters<typeof createPoll>[0];
    await createPoll(crafted);
    const data = sentData();
    expect(data.visibleToGuests).toBe(false);
    expect(data.guestsCanVote).toBe(false);
  });

  it("turns a role that may not create polls away before any write", async () => {
    for (const role of ["member", "guest", "department_head", null]) {
      strapiMock.mockClear();
      viewerMock.mockResolvedValue({ id: 2, displayName: "M", role, department: null });
      await expect(createPoll(input([3])), String(role)).resolves.toEqual({
        ok: false,
        code: "forbidden",
      });
      expect(strapiMock).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["a 400", cmsError(400, "Invalid options"), "invalid"],
    ["a 403", cmsError(403, "Forbidden"), "forbidden"],
    ["a 500", cmsError(500, "Internal Server Error"), "unavailable"],
    ["a network error", new TypeError("fetch failed"), "unavailable"],
    ["an unexpected error", new Error("boom"), "failed"],
  ])("answers %s as %s", async (_label, error, code) => {
    strapiMock.mockRejectedValue(error);
    await expect(createPoll(input([3]))).resolves.toEqual({ ok: false, code });
  });

  it("refuses a closing day that is no date before any request", async () => {
    await expect(createPoll({ ...input([]), closesAt: "2026-02-31" })).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("lets the expired-session redirect escape instead of answering failed (FX47)", async () => {
    // What strapi() throws on a 401 with a token: the real redirect() error,
    // checked by the real unstable_rethrow.
    const expired = captureRedirect("/sign-in?expired=1");
    strapiMock.mockRejectedValue(expired);
    await expect(createPoll(input([3]))).rejects.toBe(expired);
  });

  it("neither refreshes nor tags a cache", async () => {
    await createPoll(input([3]));
    expect(refreshMock).not.toHaveBeenCalled();
    expect(updateTagMock).not.toHaveBeenCalled();
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });
});

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
    expect(controller).toContain('ctx.badRequest("Poll options changed")');
  });
});
