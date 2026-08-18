import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/api/users` is NOT a regular content-type endpoint: it answers with a
 * plain array (no `meta.pagination`) and ignores `pagination[...]`, so
 * `fetchAllUsers` walks it with explicit `start`/`limit` and stops at a hard
 * `MAX_USERS` cap. The acknowledgement report derives its TARGET AUDIENCE
 * from this directory, so a cap hit that silently shrinks the roster used to
 * read as a green "everyone confirmed" — these tests pin the walk and the
 * `truncated` signal callers need to fail closed (#14).
 *
 * `@/lib/strapi` is mocked wholesale — the real module pulls in next/auth and
 * only its URL contract (start/limit, sort) matters here.
 */
const strapiMock = vi.fn();
vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));

const { fetchAllUsers } = await import("./users");

const urls = () => strapiMock.mock.calls.map((c) => String(c[0]));

/** Parse the `start`/`limit` the walk asked for out of a request URL. */
const range = (url: string) => ({
  start: Number(/[?&]start=(\d+)/.exec(url)?.[1] ?? 0),
  limit: Number(/[?&]limit=(\d+)/.exec(url)?.[1] ?? 0),
});

/** A full page of `limit` sequential user rows starting at `start`. */
const fullPage = (url: string) => {
  const { start, limit } = range(url);
  return Array.from({ length: limit }, (_, i) => ({ id: start + i + 1 }));
};

beforeEach(() => {
  strapiMock.mockReset();
});

describe("fetchAllUsers", () => {
  it("forces a deterministic id sort when the caller passes none", async () => {
    strapiMock.mockResolvedValueOnce([{ id: 1 }]);
    await fetchAllUsers();
    // Without ORDER BY, a start/limit walk can skip or duplicate rows.
    expect(urls()[0]).toContain("sort=id:asc");
    expect(urls()[0]).toContain("start=0");
    expect(urls()[0]).toContain("limit=100");
  });

  it("keeps the caller's sort instead of appending its own", async () => {
    strapiMock.mockResolvedValueOnce([{ id: 1 }]);
    await fetchAllUsers("sort=displayName:asc");
    expect(urls()[0]).toContain("sort=displayName:asc");
    expect(urls()[0]).not.toContain("sort=id:asc");
  });

  it("walks every page and concatenates the directory", async () => {
    // A FULL first page (== limit) forces a second request; the short second
    // page is the natural end.
    strapiMock
      .mockImplementationOnce(async (url: string) => fullPage(url)) // ids 1..100
      .mockResolvedValueOnce([{ id: 101 }]);
    const { users, truncated } = await fetchAllUsers();
    expect(users).toHaveLength(101);
    expect(users.at(-1)!.id).toBe(101);
    expect(truncated).toBe(false);
    expect(strapiMock).toHaveBeenCalledTimes(2);
    expect(urls()[1]).toContain("start=100");
  });

  it("stops at the natural end (last page shorter than the limit)", async () => {
    strapiMock.mockResolvedValueOnce([{ id: 1 }]);
    const { users, truncated } = await fetchAllUsers();
    expect(users).toHaveLength(1);
    expect(truncated).toBe(false);
    expect(strapiMock).toHaveBeenCalledTimes(1);
  });

  it("treats an empty first page as an empty, complete directory", async () => {
    strapiMock.mockResolvedValueOnce([]);
    const { users, truncated } = await fetchAllUsers();
    expect(users).toEqual([]);
    expect(truncated).toBe(false);
    expect(strapiMock).toHaveBeenCalledTimes(1);
  });

  it("treats a non-array (DEMO_MODE) response as an empty page", async () => {
    strapiMock.mockResolvedValueOnce({ data: [], meta: {} });
    const { users, truncated } = await fetchAllUsers();
    expect(users).toEqual([]);
    expect(truncated).toBe(false);
    expect(strapiMock).toHaveBeenCalledTimes(1);
  });

  it("flags truncated and warns when the MAX_USERS cap cuts the walk short", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The directory keeps returning FULL pages past the 2000-row cap, so the
    // walk stops with rows still unseen: the result is INCOMPLETE.
    strapiMock.mockImplementation(async (url: string) => fullPage(url));
    const { users, truncated } = await fetchAllUsers();
    expect(truncated).toBe(true);
    expect(users).toHaveLength(2000);
    // 2000 / 100 = 20 pages before the cap is reached.
    expect(strapiMock).toHaveBeenCalledTimes(20);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("[list-cap]");
    expect(message).toContain("2000-row safety cap");
    expect(message).toContain("INCOMPLETE");
    warn.mockRestore();
  });

  it("does NOT flag truncated when the last page under the cap is short", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 19 full pages then a short one lands exactly at the natural end just
    // shy of the cap — complete, so no truncation and no warning.
    strapiMock.mockImplementation(async (url: string) => {
      const { start } = range(url);
      return start >= 1900 ? [{ id: start + 1 }] : fullPage(url);
    });
    const { users, truncated } = await fetchAllUsers();
    expect(truncated).toBe(false);
    expect(users).toHaveLength(19 * 100 + 1);
    expect(strapiMock).toHaveBeenCalledTimes(20);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
