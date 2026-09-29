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

describe("unused populates are gone (WD05)", () => {
  const onePage = {
    data: [],
    meta: { pagination: { page: 1, pageSize: 100, pageCount: 1, total: 0 } },
  };
  const iso = "2026-09-24T00:00:00.000Z";

  it.each([
    ["events.upcoming", () => api.events.upcoming(iso, iso), "populate[departments]"],
    ["events.past", () => api.events.past(iso, iso), "populate[departments]"],
    ["events.window", () => api.events.window(iso, iso), "populate[departments]"],
    ["announcements.list", () => api.announcements.list(), "populate[department]"],
    ["departments.list", () => api.departments.list(), "populate[headerImage]"],
    ["departments.one", () => api.departments.one("engineering"), "populate[headerImage]"],
    ["polls.list", () => api.polls.list(), "populate[author]"],
  ] as const)("%s sends no %s", async (_label, read, populate) => {
    fetchMock.mockImplementation(async () => json(onePage));
    await read();
    expect(paths().length).toBeGreaterThan(0);
    for (const path of paths()) expect(path).not.toContain(populate);
  });

  it("keeps what the pages render: the organizer name, the author, the head and teams", async () => {
    fetchMock.mockImplementation(async () => json(onePage));
    await api.events.upcoming(iso, iso);
    await api.announcements.list();
    await api.departments.list();
    const [events, announcements, departments] = paths();
    expect(events).toContain("populate[organizer][fields][0]=displayName");
    expect(announcements).toContain("populate[author][fields][2]=displayName");
    expect(departments).toContain("populate[head][fields][0]=displayName");
    expect(departments).toContain("populate[teams]=true");
  });
});

/**
 * A tiny evaluator of the Strapi filters these helpers send: `filters[...]`
 * brackets into a tree, implicit AND per object, `$or` over its entries,
 * and SQL's three-valued logic (a comparison with NULL is never true;
 * `$null` tests it). Enough to prove that the two lists split the events.
 */
type FilterNode = { [key: string]: FilterNode | string };
type Row = { start: string; end: string | null; allDay: boolean | null };

function filterTree(path: string): FilterNode {
  const root: FilterNode = {};
  const query = path.slice(path.indexOf("?") + 1);
  for (const pair of query.split("&")) {
    const [rawKey, rawValue = ""] = pair.split("=");
    const key = decodeURIComponent(rawKey!);
    if (!key.startsWith("filters[")) continue;
    const parts = [...key.slice("filters".length).matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]!);
    let node = root;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) node[part] = decodeURIComponent(rawValue);
      else node = (node[part] ??= {}) as FilterNode;
    });
  }
  return root;
}

function holds(node: FilterNode, row: Row): boolean {
  return Object.entries(node).every(([key, value]) => {
    if (key === "$or")
      return Object.values(value as FilterNode).some((c) => holds(c as FilterNode, row));
    const cell = row[key as keyof Row];
    return Object.entries(value as FilterNode).every(([op, raw]) => {
      if (op === "$null") return (cell === null) === (raw === "true");
      if (cell === null) return false;
      if (op === "$eq") return String(cell) === raw;
      const [a, b] = [Date.parse(String(cell)), Date.parse(String(raw))];
      if (op === "$gte") return a >= b;
      if (op === "$lt") return a < b;
      throw new Error(`operator ${op} not modelled`);
    });
  });
}

describe("api.events.upcoming / past: running events stay upcoming (FX49)", () => {
  // Berlin: today is Tuesday 6 Oct 2026 (it starts at 22:00Z the day before), now is 12:00.
  const START_OF_TODAY = "2026-10-05T22:00:00.000Z";
  const NOW = "2026-10-06T10:00:00.000Z";

  it("asks for start >= today or still running, soonest first, and past as the rest", async () => {
    await api.events.upcoming(START_OF_TODAY, NOW);
    await api.events.past(START_OF_TODAY, NOW);
    const [upcoming, past] = paths();
    expect(upcoming).toContain(`filters[$or][0][start][$gte]=${START_OF_TODAY}`);
    expect(upcoming).toContain(`filters[$or][1][end][$gte]=${NOW}`);
    expect(upcoming).toContain(
      `filters[$or][2][allDay][$eq]=true&filters[$or][2][end][$gte]=${START_OF_TODAY}`,
    );
    expect(upcoming).toContain("sort=start:asc&pagination[pageSize]=50");
    expect(past).toContain(`filters[start][$lt]=${START_OF_TODAY}`);
    expect(past).toContain("sort=start:desc&pagination[pageSize]=10");
  });

  const cases: [string, Row, "upcoming" | "past"][] = [
    ["later today", { start: "2026-10-06T14:00:00.000Z", end: null, allDay: false }, "upcoming"],
    [
      "earlier today, over",
      { start: "2026-10-06T06:00:00.000Z", end: "2026-10-06T07:00:00.000Z", allDay: false },
      "upcoming",
    ],
    [
      "multi-day, running",
      { start: "2026-10-04T07:00:00.000Z", end: "2026-10-07T15:00:00.000Z", allDay: false },
      "upcoming",
    ],
    [
      "multi-day, ended this morning",
      { start: "2026-10-04T07:00:00.000Z", end: "2026-10-06T08:00:00.000Z", allDay: false },
      "past",
    ],
    [
      "yesterday",
      { start: "2026-10-05T07:00:00.000Z", end: "2026-10-05T08:00:00.000Z", allDay: false },
      "past",
    ],
    ["yesterday, no end", { start: "2026-10-05T07:00:00.000Z", end: null, allDay: false }, "past"],
    [
      "all-day, last day today",
      { start: "2026-10-03T22:00:00.000Z", end: "2026-10-05T22:00:00.000Z", allDay: true },
      "upcoming",
    ],
    [
      "all-day, ended yesterday",
      { start: "2026-10-03T22:00:00.000Z", end: "2026-10-04T22:00:00.000Z", allDay: true },
      "past",
    ],
    [
      "all-day, no end, yesterday",
      { start: "2026-10-04T22:00:00.000Z", end: null, allDay: true },
      "past",
    ],
    [
      "allDay NULL, running",
      { start: "2026-10-04T07:00:00.000Z", end: "2026-10-07T15:00:00.000Z", allDay: null },
      "upcoming",
    ],
    [
      "allDay NULL, ended this morning",
      { start: "2026-10-04T07:00:00.000Z", end: "2026-10-06T08:00:00.000Z", allDay: null },
      "past",
    ],
    [
      "next week",
      { start: "2026-10-13T07:00:00.000Z", end: "2026-10-13T08:00:00.000Z", allDay: false },
      "upcoming",
    ],
    [
      "all-day next week",
      { start: "2026-10-12T22:00:00.000Z", end: null, allDay: true },
      "upcoming",
    ],
  ];

  it.each(cases)("lists %s under exactly one heading", async (_label, row, expected) => {
    await api.events.upcoming(START_OF_TODAY, NOW);
    await api.events.past(START_OF_TODAY, NOW);
    const [upcoming, past] = paths().map(filterTree);
    expect({ upcoming: holds(upcoming!, row), past: holds(past!, row) }).toEqual({
      upcoming: expected === "upcoming",
      past: expected === "past",
    });
  });
});
