import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WD01 safety net: the exact request of every Strapi READ the web makes,
 * pinned in a file snapshot (__snapshots__/strapi-urls.txt) so that moving
 * the data client around (lib/strapi.ts → lib/strapi/*, lib/api/*) cannot
 * change a single byte on the wire: the URL string (parameter order and
 * percent-encoding included) and the fetch options strapi() sends (method,
 * cache mode, headers, body, and nothing else, e.g. no `next`).
 *
 * Covered: every `api.*` helper (the coverage check below fails when one is
 * added without a case), the lib helpers that call strapi() directly for
 * reads (users, teams, acknowledgements, training, the viewer, the topbar's
 * notification feed, the ⌘K search, the comment sections: the batched
 * reactions read in chunks of 50, the newest-100 comment windows and the
 * own-reaction lookup), and the pages that do (the three /manage reports,
 * the person page, the profile page). Not covered: the image lookup of
 * updateClassified (classified-actions.ts), a read inside a mutation.
 *
 * Mocked: global fetch (canned bodies per path, below), `@/lib/session`
 * (a signed-in session with the token `jwt-test`), `@/lib/config` (the CMS
 * base URL) and next-intl. Everything else is the real code, including
 * getViewer(), which reads /api/me and makes the page callers admins.
 *
 * The calls of one case are listed sorted: parallel reads (Promise.all) may
 * start in a different order after a refactor without any change on the
 * wire, and the snapshot pins what is sent, not the scheduling.
 */

const STRAPI = "http://cms.test";
/** A fixed instant for every time-dependent read (Monday 2026-09-28, 10:00 UTC). */
const NOW = new Date("2026-09-28T10:00:00.000Z");
const ISO_TODAY = "2026-09-27T22:00:00.000Z";
const ISO_NOW = "2026-09-28T10:00:00.000Z";

type Call = [url: string, init: RequestInit];
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

vi.mock("@/lib/session", () => ({
  getSession: async () => ({
    user: { id: 1, name: "Test User", email: "test@example.test" },
    expires: "2999-01-01T00:00:00.000Z",
    provider: "local",
  }),
  getStrapiToken: async () => "jwt-test",
}));
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  STRAPI_URL: STRAPI,
  DEMO_MODE: false,
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace?: string) => {
    const t = (key: string) => `${namespace ?? ""}.${key}`;
    return Object.assign(t, { rich: t, markup: t, raw: t, has: () => true });
  },
  getLocale: async () => "en",
  getFormatter: async () => ({
    dateTime: () => "date",
    relativeTime: () => "relative",
    number: (n: number) => String(n),
  }),
}));
vi.stubGlobal("fetch", fetchMock);

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const onePage = (data: unknown[] = []) => ({
  data,
  meta: { pagination: { page: 1, pageSize: 100, pageCount: 1, total: data.length } },
});
/** A comment target whose reactions overflow the newest-500 window. */
const OVERFLOW_DOC = "overflow-doc";

/**
 * The canned body per path: enough for every caller to go on to its next
 * read (the ack report to its ack chunks, the training report to a course's
 * progress walk) and for getViewer() to see an admin.
 */
function respond(url: string): Response {
  const path = url.slice(STRAPI.length);
  if (path === "/api/me") {
    return json({
      data: {
        id: 1,
        documentId: "user-doc-1",
        displayName: "Test User",
        role: { type: "admin_role" },
        department: null,
      },
    });
  }
  if (path.startsWith("/api/users/")) return json({ id: 7, displayName: "Person" });
  if (path.startsWith("/api/users?")) return json([]);
  if (path.startsWith("/api/search-logs/summary")) {
    return json({ windowDays: 30, total: 0, zeroResultCount: 0, topTerms: [], topZeroTerms: [] });
  }
  if (path.startsWith("/api/event-rsvps/summary") || path.startsWith("/api/celebrations")) {
    return json({ data: [] });
  }
  if (/^\/api\/polls\/[^/?]+\/results/.test(path)) {
    return json({ poll: { id: 1, question: "Q", options: ["a", "b"] }, counts: [0, 0], total: 0 });
  }
  if (path.startsWith("/api/announcements?filters[requiresAck][$eq]=true&populate[department]")) {
    return json(onePage([{ id: 1, documentId: "ann-doc-1", requiresAck: true }]));
  }
  if (
    path.startsWith("/api/reactions?") &&
    path.includes(`$eq]=${OVERFLOW_DOC}`) &&
    !path.includes("filters[author]")
  ) {
    // More rows than the window holds: the section reads the target on its
    // own and then looks up the caller's own reactions.
    return json({
      data: [],
      meta: { pagination: { page: 1, pageSize: 500, pageCount: 2, total: 501 } },
    });
  }
  if (path.startsWith("/api/courses?")) {
    return json(
      onePage([
        {
          id: 1,
          documentId: "course-doc-1",
          slug: "security",
          title: "Security",
          mandatory: true,
          lessons: [{ id: 2, documentId: "lesson-doc-1", title: "L1", order: 1 }],
        },
      ]),
    );
  }
  return json(onePage());
}

/** One call as a snapshot line: method, URL and every fetch option strapi() set. */
function describeCall([url, init]: Call): string {
  const headers = [...new Headers(init.headers).entries()]
    .map(([name, value]) => `${name}=${value}`)
    .sort()
    .join(",");
  const other = Object.keys(init)
    .filter((key) => !["method", "headers", "cache", "body"].includes(key))
    .sort();
  return [
    `${init.method ?? "GET"} ${url}`,
    `cache=${String(init.cache)}`,
    `headers[${headers}]`,
    ...(init.body === undefined ? [] : [`body=${String(init.body)}`]),
    ...(other.length > 0 ? [`other=${other.join(",")}`] : []),
  ].join(" ");
}

const { api } = await import("./strapi");
const { fetchAllTeams } = await import("./teams");
const { fetchAllUsers } = await import("./users");
const { fetchAnnouncementAckIndex, fetchMyAnnouncementAcks } = await import("./acknowledgements");
const training = await import("./training");
const { getViewer } = await import("./viewer");
const { getNotifications } = await import("./notification-actions");
const { PRELOAD_KINDS, loadPreload, searchLive } = await import("./search-action");
const { getCommentSection, getCommentSections } = await import("./comment-actions");
const { default: AckReportPage } = await import("@/app/(app)/manage/acknowledgements/page");
const { default: AnalyticsPage } = await import("@/app/(app)/manage/analytics/page");
const { default: TrainingReportPage } = await import("@/app/(app)/manage/training/page");
const { default: PersonPage } = await import("@/app/(app)/people/[id]/page");
const { default: ProfilePage } = await import("@/app/(app)/profile/page");

/** One call per api.* helper, keyed "group.name" (the coverage check below). */
const API_READS: Record<string, () => Promise<unknown>> = {
  "departments.list": () => api.departments.list(),
  "departments.one": () => api.departments.one("research & development"),
  "teams.list": () => api.teams.list(),
  "teams.one": () => api.teams.one("platform"),
  "wiki.spaces": () => api.wiki.spaces(),
  "wiki.space": () => api.wiki.space("hand/book"),
  "wiki.page": () => api.wiki.page("handbook", "on boarding"),
  "announcements.list": () => api.announcements.list(),
  "announcements.requiringAck": () => api.announcements.requiringAck(),
  "events.upcoming": () => api.events.upcoming(ISO_TODAY, ISO_NOW),
  "events.past": () => api.events.past(ISO_TODAY, ISO_NOW),
  "events.window": () => api.events.window("2026-08-31T22:00:00.000Z", ISO_NOW),
  "events.rsvpSummaries": () =>
    api.events.rsvpSummaries(
      Array.from({ length: 52 }, (_, i) => `k3m9x00000000000000000${String(i).padStart(2, "0")}`),
    ),
  "polls.list": () => api.polls.list(),
  "polls.results": async () => {
    await api.polls.results("k3m9x0000000000000000001");
    await api.polls.results(7);
  },
  "polls.resultsMany": () =>
    api.polls.resultsMany([
      ...Array.from(
        { length: 50 },
        (_, i) => `k3m9x00000000000000000${String(i).padStart(2, "0")}`,
      ),
      7,
    ]),
  "documents.list": () => api.documents.list(),
  "kudos.list": () => api.kudos.list(),
  "classifieds.list": async () => {
    await api.classifieds.list("2026-09-28");
    await api.classifieds.list("2026-09-28", "service-offer");
  },
  "classifieds.mine": () => api.classifieds.mine(7),
  "classifieds.one": () => api.classifieds.one("12"),
  "quickLinks.list": () => api.quickLinks.list(),
  celebrations: () => api.celebrations(),
};

/** The direct strapi() read callers outside `api`. */
const DIRECT_READS: Record<string, () => Promise<unknown>> = {
  "teams.fetchAllTeams": () => fetchAllTeams(),
  "users.fetchAllUsers()": () => fetchAllUsers(),
  "users.fetchAllUsers(fields[0]=id)": () => fetchAllUsers("fields[0]=id"),
  "users.fetchAllUsers(sorted)": () => fetchAllUsers("fields[0]=displayName&sort=displayName:asc"),
  "acknowledgements.fetchMyAnnouncementAcks": () => fetchMyAnnouncementAcks(),
  "acknowledgements.fetchAnnouncementAckIndex": () =>
    fetchAnnouncementAckIndex(
      Array.from({ length: 21 }, (_, i) => `ann doc ${i}`).concat(["ann doc 0", ""]),
    ),
  "training.fetchCourses": () => training.fetchCourses(),
  "training.fetchCourseBySlug": () => training.fetchCourseBySlug("security & safety"),
  "training.fetchLessonByDocumentId": () => training.fetchLessonByDocumentId("lesson/doc 1"),
  "training.fetchCourseProgress": () =>
    training.fetchCourseProgress(["lesson-doc-1", "lesson doc 2"], "label"),
  "training.fetchMyProgress": () => training.fetchMyProgress(),
  "viewer.getViewer": () => getViewer(),
  "topbar.getNotifications": () => getNotifications(),
  ...Object.fromEntries(
    PRELOAD_KINDS.map((kind) => [`search.loadPreload(${kind})`, () => loadPreload(kind, NOW)]),
  ),
  "search.searchLive(member)": () => searchLive("Ab&c", async () => "member"),
  "search.searchLive(guest)": () => searchLive("Ab&c", async () => "guest"),
  "comments.getCommentSection": () =>
    getCommentSection({ type: "announcement", documentId: "ann doc/1" }),
  "comments.getCommentSections(1)": () =>
    getCommentSections([{ type: "wiki-page", documentId: "wiki-doc-1" }]),
  // 51 distinct targets of both types (two reaction batches: 50 + 1), plus
  // a duplicate and a target without an anchor, which send nothing.
  "comments.getCommentSections(51)": () =>
    getCommentSections([
      ...Array.from({ length: 51 }, (_, i) => ({
        type: i % 2 === 0 ? ("announcement" as const) : ("wiki-page" as const),
        documentId: `k3m9x00000000000000000${String(i).padStart(2, "0")}`,
      })),
      { type: "announcement", documentId: "k3m9x0000000000000000000" },
      { type: "wiki-page", documentId: " " },
    ]),
  "comments.getCommentSection(reaction overflow)": () =>
    getCommentSection({ type: "announcement", documentId: OVERFLOW_DOC }),
  "page.manage/acknowledgements": () => AckReportPage(),
  "page.manage/analytics": () => AnalyticsPage(),
  "page.manage/training": () => TrainingReportPage(),
  "page.people/[id]": () => PersonPage({ params: Promise.resolve({ id: "7" }) }),
  "page.profile": () => ProfilePage(),
};

/** "group.name" for every function reachable in `api` (one level deep). */
function apiHelperNames(): string[] {
  const names: string[] = [];
  for (const [group, value] of Object.entries(api)) {
    if (typeof value === "function") names.push(group);
    else for (const name of Object.keys(value)) names.push(`${group}.${name}`);
  }
  return names.sort();
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url) => respond(url));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("Strapi read requests (WD01 snapshot)", () => {
  it("has a case for every api.* helper", () => {
    expect(Object.keys(API_READS).sort()).toEqual(apiHelperNames());
  });

  it("sends byte-identical requests to the committed snapshot", async () => {
    const sections: string[] = [];
    const cases = [
      ...Object.entries(API_READS).map(([name, read]) => [`api.${name}`, read] as const),
      ...Object.entries(DIRECT_READS),
    ];
    for (const [name, read] of cases) {
      fetchMock.mockClear();
      await read();
      const calls = (fetchMock.mock.calls as Call[]).map(describeCall).sort();
      expect(calls.length, name).toBeGreaterThan(0);
      sections.push(`## ${name}\n${calls.join("\n")}`);
    }
    await expect(`${sections.join("\n\n")}\n`).toMatchFileSnapshot(
      "./__snapshots__/strapi-urls.txt",
    );
  });
});
