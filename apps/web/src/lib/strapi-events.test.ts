import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The exact requests of the events helpers in lib/strapi.ts (FX21, WD05).
 * strapi.test.ts pins the transport contract for every helper; this file
 * pins what the events page asks the CMS for. `@/lib/session` and
 * `@/lib/config` are mocked like in strapi.test.ts, fetch is stubbed.
 */
const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();

vi.mock("@/lib/session", () => ({ getStrapiToken: async () => "jwt-abc" }));
vi.mock("@/lib/config", () => ({ STRAPI_URL: "http://cms.test", DEMO_MODE: false }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.stubGlobal("fetch", fetchMock);

const { api } = await import("./strapi");

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const paths = () =>
  fetchMock.mock.calls.map(([url]) => decodeURIComponent(url.replace("http://cms.test", "")));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => json({ data: [] }));
});

describe("api.events.rsvpSummaries (FX21)", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${String(i).padStart(23, "0")}`);

  it("asks the summary endpoint once for up to 50 events, never the raw rows", async () => {
    fetchMock.mockImplementation(async () =>
      json({ data: [{ targetDocumentId: ids(1)[0], yesCount: 1 }] }),
    );
    const result = await api.events.rsvpSummaries(ids(2));
    expect(paths()).toEqual([`/api/event-rsvps/summary?targets=${ids(2).join(",")}`]);
    expect(result).toEqual({ data: [{ targetDocumentId: ids(1)[0], yesCount: 1 }] });
  });

  it("splits more than 50 events into requests of 50 and concatenates the answers", async () => {
    fetchMock.mockImplementation(async (url: string) => json({ data: [{ url: url.length }] }));
    const all = ids(120);
    const result = await api.events.rsvpSummaries(all);
    expect(paths()).toEqual([
      `/api/event-rsvps/summary?targets=${all.slice(0, 50).join(",")}`,
      `/api/event-rsvps/summary?targets=${all.slice(50, 100).join(",")}`,
      `/api/event-rsvps/summary?targets=${all.slice(100).join(",")}`,
    ]);
    expect(result.data).toHaveLength(3);
  });

  it("sends no request without events and reads a body without data as empty", async () => {
    await expect(api.events.rsvpSummaries([])).resolves.toEqual({ data: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementation(async () => json({}));
    await expect(api.events.rsvpSummaries(ids(1))).resolves.toEqual({ data: [] });
  });
});
