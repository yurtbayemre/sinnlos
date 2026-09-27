import { beforeEach, describe, expect, it, vi } from "vitest";

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
 * `@/lib/strapi`, `@/lib/viewer` and `next/cache` are mocked: only the
 * request the action builds matters here.
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
});

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
    const crafted = { ...input([]), visibleToGuests: "true", guestsCanVote: 1 } as unknown as Parameters<
      typeof createPoll
    >[0];
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

  it("answers failed when the CMS refuses the write", async () => {
    strapiMock.mockRejectedValue(new Error("400"));
    await expect(createPoll(input([3]))).resolves.toEqual({ ok: false, code: "failed" });
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
    await votePoll(4, 1);
    expect(strapiMock).toHaveBeenCalledWith("/api/polls/4/vote", {
      method: "POST",
      body: JSON.stringify({ optionIndex: 1 }),
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });
});
