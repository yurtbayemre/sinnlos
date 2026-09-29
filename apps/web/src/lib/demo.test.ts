import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The DEMO_MODE contract (DM01-lite, lib/demo.ts): every path template the
 * web reads through strapi() has a fixture route, answers the envelope the
 * caller expects (a list with a real `meta.pagination`, a bare array for
 * /api/users, the bare user for /api/users/:id and /me, a results body for
 * a poll), the request's filters apply (upcoming events contain no past
 * event), page walks end, an unknown poll answers 404, and nothing falls
 * through to the empty default (which warns).
 *
 * `@/lib/config` switches DEMO_MODE on; `@/lib/session` is mocked so that a
 * session read or a token request would show (strapi() must answer before
 * either); fetch must never run.
 */
const state = vi.hoisted(() => ({ tokenReads: 0 }));
const fetchMock = vi.fn();

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  DEMO_MODE: true,
}));
vi.mock("@/lib/session", () => ({
  getSession: async () => ({
    user: { id: 1, name: "Ada Lovelace", email: "ada@sinnlos.local", image: null },
    expires: "9999-12-31T23:59:59.999Z",
  }),
  getStrapiToken: async () => {
    state.tokenReads += 1;
    return null;
  },
}));
vi.stubGlobal("fetch", fetchMock);

const { api, strapi, StrapiError } = await import("./strapi");
const { demo } = await import("./demo");
const { fetchAllTeams } = await import("./teams");
const { fetchAllUsers } = await import("./users");
const { fetchAnnouncementAckIndex, fetchMyAnnouncementAcks } = await import("./acknowledgements");
const training = await import("./training");
const { DEMO_VIEWER, toViewer } = await import("./viewer");
const { getNotifications } = await import("./notification-actions");
const { PEOPLE_QUERY, ORG_CHART_QUERY, kudosRecipientQuery } = await import("./people-dto");
const { zonedDateKey, zonedDayStart, addDaysToKey } = await import("./plain-date");
const { appTimeZone } = await import("./app-time-zone");

const ZONE = appTimeZone();
const NOW = new Date();
const TODAY = zonedDayStart(zonedDateKey(NOW, ZONE), ZONE).toISOString();
const NOW_ISO = NOW.toISOString();

type Row = Record<string, unknown>;
type Listed = {
  data: Row[];
  meta: { pagination: { page: number; pageCount: number; total: number } };
};

/** One call per api.* helper, keyed "group.name" (the coverage check below). */
const API_READS: Record<string, () => Promise<unknown>> = {
  "departments.list": () => api.departments.list(),
  "departments.one": () => api.departments.one("engineering"),
  "teams.list": () => api.teams.list(),
  "teams.one": () => api.teams.one("platform"),
  "wiki.spaces": () => api.wiki.spaces(),
  "wiki.space": () => api.wiki.space("handbook"),
  "wiki.page": () => api.wiki.page("handbook", "welcome"),
  "announcements.list": () => api.announcements.list(),
  "announcements.requiringAck": () => api.announcements.requiringAck(),
  "events.upcoming": () => api.events.upcoming(TODAY, NOW_ISO),
  "events.past": () => api.events.past(TODAY, NOW_ISO),
  "events.window": () =>
    api.events.window(
      zonedDayStart(addDaysToKey(zonedDateKey(NOW, ZONE), -10), ZONE).toISOString(),
      zonedDayStart(addDaysToKey(zonedDateKey(NOW, ZONE), 10), ZONE).toISOString(),
    ),
  "events.rsvpSummaries": () => api.events.rsvpSummaries(["demo-event-1", "demo-event-2"]),
  "polls.list": () => api.polls.list(),
  "polls.results": () => api.polls.results("demo-poll-1"),
  "polls.resultsMany": () => api.polls.resultsMany([1, "demo-poll-2"]),
  "documents.list": () => api.documents.list(),
  "kudos.list": () => api.kudos.list(),
  "classifieds.list": () => api.classifieds.list(zonedDateKey(NOW, ZONE)),
  "classifieds.mine": () => api.classifieds.mine(1),
  "classifieds.one": () => api.classifieds.one("1"),
  "quickLinks.list": () => api.quickLinks.list(),
  celebrations: () => api.celebrations(),
};

/** The direct readers outside `api`. */
const DIRECT_READS: Record<string, () => Promise<unknown>> = {
  fetchAllTeams: () => fetchAllTeams(),
  "fetchAllUsers(people)": () => fetchAllUsers(PEOPLE_QUERY),
  "fetchAllUsers(org chart)": () => fetchAllUsers(ORG_CHART_QUERY),
  "fetchAllUsers(kudos)": () => fetchAllUsers(kudosRecipientQuery(1)),
  fetchMyAnnouncementAcks: () => fetchMyAnnouncementAcks(),
  fetchAnnouncementAckIndex: () => fetchAnnouncementAckIndex(["demo-ann-1"]),
  fetchCourses: () => training.fetchCourses(),
  fetchCourseBySlug: () => training.fetchCourseBySlug("security-awareness-basics"),
  fetchLessonByDocumentId: () => training.fetchLessonByDocumentId("demo-lesson-1"),
  fetchCourseProgress: () => training.fetchCourseProgress(["demo-lesson-1"], "demo"),
  fetchMyProgress: () => training.fetchMyProgress(),
  getNotifications: () => getNotifications(),
  "me (/api/me)": () => strapi("/api/me"),
  "person (/api/users/:id)": () => strapi("/api/users/2?populate[department]=true"),
};

function apiHelperNames(): string[] {
  const names: string[] = [];
  for (const [group, value] of Object.entries(api)) {
    if (typeof value === "function") names.push(group);
    else for (const name of Object.keys(value)) names.push(`${group}.${name}`);
  }
  return names.sort();
}

const warnings = () =>
  (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith("[demo]"));

const listOf = (body: unknown) => body as Listed;

beforeEach(() => {
  state.tokenReads = 0;
  fetchMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("DEMO_MODE: every read has a fixture route", () => {
  it("has a case for every api.* helper", () => {
    expect(Object.keys(API_READS).sort()).toEqual(apiHelperNames());
  });

  it.each([...Object.entries(API_READS), ...Object.entries(DIRECT_READS)])(
    "%s answers from the fixtures, without a fetch, a token read or a fall-through",
    async (_, read) => {
      await read();
      expect(warnings()).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(state.tokenReads).toBe(0);
    },
  );

  it("warns (outside production) and answers an empty list for an unknown path", () => {
    expect(listOf(demo("/api/nothing-here?x=1")).data).toEqual([]);
    expect(warnings()).toEqual(["[demo] no fixture for /api/nothing-here?x=1"]);
  });
});

describe("DEMO_MODE: envelopes", () => {
  it("lists carry a real pagination, and a page walk ends", async () => {
    const departments = await api.departments.list();
    expect(departments.truncated).toBe(false);
    expect(departments.data.length).toBe(3);
    const page = listOf(demo("/api/announcements?pagination[page]=2&pagination[pageSize]=4"));
    expect(page.meta.pagination).toEqual({ page: 2, pageSize: 4, pageCount: 2, total: 6 });
    expect(page.data.map((a) => a.id)).toEqual([5, 6]);
    // A count read (pageSize 1) sees the total.
    expect(listOf(demo("/api/announcements?&pagination[pageSize]=1")).meta.pagination.total).toBe(
      6,
    );
  });

  it("answers /api/users with a bare array paged by start/limit", async () => {
    const all = demo("/api/users?sort=id:asc&start=0&limit=100");
    expect(Array.isArray(all)).toBe(true);
    expect((all as Row[]).map((u) => u.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(demo("/api/users?sort=id:asc&start=2&limit=2")).toMatchObject([{ id: 3 }, { id: 4 }]);
    expect(demo("/api/users?sort=id:asc&start=100&limit=100")).toEqual([]);
    const { users, truncated } = await fetchAllUsers<{ id: number }>("fields[0]=id");
    expect(users.map((u) => u.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(truncated).toBe(false);
  });

  it("answers /api/users/:id and /api/users/me with the bare user (no 'Unknown' person)", () => {
    expect(demo("/api/users/2?populate[department]=true")).toMatchObject({
      id: 2,
      displayName: "Grace Hopper",
    });
    expect(demo("/api/users/me")).toMatchObject({ id: 1, displayName: "Ada Lovelace" });
    // An unknown id: an empty body, as the users-permissions findOne answers.
    expect(demo("/api/users/999")).toBeUndefined();
  });

  it("gives /api/me the demo viewer, so the profile and the viewer agree", () => {
    const me = demo("/api/me") as { data: unknown };
    expect(toViewer(me.data)).toEqual(DEMO_VIEWER);
  });

  it("filters the users like Strapi: the kudos picker leaves out the caller", async () => {
    const { users } = await fetchAllUsers<{ id: number }>(kudosRecipientQuery(1));
    expect(users.map((u) => u.id)).toEqual(expect.not.arrayContaining([1]));
    expect(users).toHaveLength(5);
  });
});

describe("DEMO_MODE: filters apply", () => {
  it("upcoming events contain no past event, past events no upcoming one", async () => {
    const upcoming = (await api.events.upcoming(TODAY, NOW_ISO)).data;
    const past = (await api.events.past(TODAY, NOW_ISO)).data;
    expect(upcoming.length).toBeGreaterThan(0);
    expect(past.length).toBeGreaterThan(0);
    for (const event of upcoming) {
      expect(event.start >= TODAY || (event.end ?? "") >= NOW_ISO, event.title).toBe(true);
    }
    for (const event of past) expect(event.start < TODAY, event.title).toBe(true);
    const ids = (rows: { id: number }[]) => rows.map((row) => row.id);
    expect(ids(upcoming).filter((id) => ids(past).includes(id))).toEqual([]);
    // Soonest first / newest first.
    expect(upcoming.map((e) => e.start)).toEqual([...upcoming.map((e) => e.start)].sort());
  });

  it("the month window takes only events overlapping it", async () => {
    const key = zonedDateKey(NOW, ZONE);
    const from = zonedDayStart(addDaysToKey(key, 5), ZONE).toISOString();
    const to = zonedDayStart(addDaysToKey(key, 20), ZONE).toISOString();
    const inWindow = (await api.events.window(from, to)).data;
    expect(inWindow.map((e) => e.title)).toEqual(["Engineering demo day"]);
  });

  it("slug, relation, $in and requiresAck filters", async () => {
    expect(listOf(await api.departments.one("engineering")).data).toHaveLength(1);
    expect(listOf(await api.departments.one("nope")).data).toEqual([]);
    expect((await api.wiki.page("handbook", "welcome")).data[0]).toMatchObject({
      title: "Welcome to Sinnlos",
      space: { slug: "handbook" },
    });
    expect((await api.wiki.page("engineering", "welcome")).data).toEqual([]);
    const acks = await api.announcements.requiringAck();
    expect(acks.data.map((a) => a.documentId)).toEqual(["demo-ann-1"]);
    const comments = listOf(
      demo(
        "/api/comments?filters[targetDocumentId][$in][0]=demo-ann-2&filters[targetDocumentId][$in][1]=demo-ann-9",
      ),
    );
    expect(comments.data.map((c) => c.id)).toEqual([3]);
    // "My ads": the demo user has none.
    expect((await api.classifieds.mine(1)).data).toEqual([]);
    expect((await api.classifieds.mine(3)).data.map((ad) => ad.id)).toEqual([1]);
  });

  it("reaches the demo user's notifications with the true unread total", async () => {
    const feed = await getNotifications();
    expect(feed.items.map((n) => n.id)).toEqual([1, 2, 3]);
    expect(feed.unreadTotal).toBe(2);
    expect(listOf(demo("/api/notifications?filters[recipient][id][$eq]=2")).data).toEqual([]);
  });

  it("summarises RSVPs per event with the demo user's own answer", async () => {
    const { data } = await api.events.rsvpSummaries(["demo-event-1", "demo-event-2"]);
    expect(data).toEqual([
      {
        targetDocumentId: "demo-event-1",
        yesCount: 2,
        maybeCount: 1,
        noCount: 1,
        yesNames: ["Ada Lovelace", "Grace Hopper"],
        myStatus: "yes",
      },
      {
        targetDocumentId: "demo-event-2",
        yesCount: 0,
        maybeCount: 0,
        noCount: 0,
        yesNames: [],
        myStatus: null,
      },
    ]);
  });
});

describe("DEMO_MODE: poll results", () => {
  it("serves a poll's results by documentId and by row id alike", async () => {
    const byDocumentId = await api.polls.results("demo-poll-2");
    expect(byDocumentId.poll.id).toBe(2);
    expect(await api.polls.results(2)).toEqual(byDocumentId);
    expect(byDocumentId).toMatchObject({ counts: [14, 5, 1], total: 20, myVoteIndex: 0 });
  });

  it("lists many polls' results in one answer, each like the single read, leaving out unknown ones (WD04)", async () => {
    const many = await api.polls.resultsMany([2, "demo-poll-9", "demo-poll-1", "demo-poll-2"]);
    expect(many.map((entry) => entry.poll.id)).toEqual([2, 1]);
    expect(many[0]).toEqual(await api.polls.results(2));
    expect(many[1]).toEqual(await api.polls.results("demo-poll-1"));
  });

  it("answers an unknown poll with a 404, like the cms (the card is dropped)", async () => {
    for (const ref of ["demo-poll-9", 9, "k3m9x0000000000000000001"]) {
      const error = await api.polls.results(ref).catch((e: unknown) => e);
      expect(error, String(ref)).toBeInstanceOf(StrapiError);
      expect(error).toMatchObject({ status: 404, strapiName: "NotFoundError" });
    }
  });
});
