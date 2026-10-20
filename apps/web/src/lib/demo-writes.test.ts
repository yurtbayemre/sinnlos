import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The DEMO_MODE writes (DM01, lib/demo/writes.ts): the real Server Actions
 * run against the demo through strapi(), get the cms's answers (refusals
 * included) and change what the reads show afterwards. No fetch, no token.
 * The demo data set is shared by the cases, so each one compares before
 * and after instead of assuming a fresh set.
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
vi.mock("@/auth", () => ({ unstable_update: vi.fn() }));
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.stubGlobal("fetch", fetchMock);

const { api, strapi } = await import("./strapi");
const { demo } = await import("./demo");
const { sendKudos } = await import("./kudos-actions");
const { rsvpToEvent } = await import("./event-actions");
const { addComment, deleteComment, getCommentSection, toggleReaction } =
  await import("./comment-actions");
const { votePoll } = await import("./poll-actions");
const { acknowledgeAnnouncement, acknowledgeDocument } = await import("./acknowledgement-actions");
const { fetchMyAnnouncementAcks, fetchMyDocumentAcks } = await import("./acknowledgements");
const { getNotifications, markAllNotificationsRead, markNotificationsRead } =
  await import("./notification-actions");
const { updateProfile } = await import("./profile-actions");
const { checkLesson, completeLesson } = await import("./training-actions");
const { fetchMyProgress } = await import("./training");
const { createClassified, deleteClassified, updateClassified } =
  await import("./classified-actions");
const { logSearch } = await import("./search-action");

const warnings = () =>
  (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith("[demo]"));

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

/** Next's redirect() control flow, as a Server Action throws it. */
const redirectTo = (path: string) => ({ digest: expect.stringContaining(`;${path};`) });

beforeEach(() => {
  state.tokenReads = 0;
  fetchMock.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled();
  expect(state.tokenReads).toBe(0);
  vi.useRealTimers();
});

describe("DEMO_MODE writes change what the reads show", () => {
  it("kudos: a new entry tops the feed; kudos to oneself is refused", async () => {
    expect(await sendKudos(2, "Thanks for the review!", "teamwork")).toEqual({ ok: true });
    const [latest] = (await api.kudos.list()).data;
    expect(latest).toMatchObject({
      message: "Thanks for the review!",
      from: { id: 1 },
      to: { id: 2, displayName: "Grace Hopper" },
    });
    expect(await sendKudos(1, "Me!", "teamwork")).toMatchObject({ ok: false, code: "invalid" });
  });

  it("RSVP: the answer replaces the demo user's own; an event without RSVP refuses", async () => {
    expect(await rsvpToEvent("demoevent000000000000001", "maybe")).toEqual({ ok: true });
    let [summary] = (await api.events.rsvpSummaries(["demoevent000000000000001"])).data;
    expect(summary).toMatchObject({ myStatus: "maybe", yesNames: ["Grace Hopper"] });
    expect(await rsvpToEvent("demoevent000000000000001", "yes")).toEqual({ ok: true });
    [summary] = (await api.events.rsvpSummaries(["demoevent000000000000001"])).data;
    expect(summary).toMatchObject({ myStatus: "yes", yesCount: 2, maybeCount: 1 });
    expect(await rsvpToEvent("demoevent000000000000002", "yes")).toMatchObject({ ok: false });
  });

  it("comments: add and delete one's own; another's comment is forbidden", async () => {
    const target = { type: "announcement" as const, documentId: "demoann00000000000000002" };
    expect(await addComment(target, "  Love it  ")).toEqual({ ok: true });
    const mine = (await getCommentSection(target)).comments.find((c) => c.body === "Love it");
    expect(mine?.author?.id).toBe(1);
    expect(await deleteComment(mine!.id)).toEqual({ ok: true });
    expect((await getCommentSection(target)).comments.some((c) => c.id === mine!.id)).toBe(false);
    expect(await deleteComment(1)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await addComment({ type: "announcement", documentId: null }, "x")).toMatchObject({
      ok: false,
    });
    // An unknown target is gone, like the cms answers it (no orphan rows).
    const gone = { type: "announcement" as const, documentId: "demoann00000000000000099" };
    expect(await addComment(gone, "Hello")).toMatchObject({ ok: false, code: "notFound" });
    expect(await toggleReaction(gone, "heart", true)).toMatchObject({
      ok: false,
      code: "notFound",
    });
  });

  it("reactions: set and unset the demo user's own", async () => {
    const target = { type: "announcement" as const, documentId: "demoann00000000000000003" };
    const own = async () =>
      (await getCommentSection(target)).reactions.find((r) => r.emoji === "lightbulb");
    expect(await toggleReaction(target, "lightbulb", true)).toEqual({ ok: true });
    expect(await own()).toMatchObject({ count: 1, reacted: true });
    expect(await toggleReaction(target, "lightbulb", true)).toEqual({ ok: true });
    expect(await own()).toMatchObject({ count: 1 });
    expect(await toggleReaction(target, "lightbulb", false)).toEqual({ ok: true });
    expect((await own())?.count ?? 0).toBe(0);
  });

  it("polls: one ballot per voter, none on a closed poll", async () => {
    const before = await api.polls.results("demopoll0000000000000001");
    if (before.myVoteIndex === null) {
      expect(await votePoll("demopoll0000000000000001", 0, before.poll.options[0])).toEqual({
        ok: true,
      });
    }
    const after = await api.polls.results("demopoll0000000000000001");
    expect(after).toMatchObject({ myVoteIndex: 0, total: 20, counts: [10, 6, 4] });
    expect(await votePoll("demopoll0000000000000001", 1)).toMatchObject({ ok: false });
    expect(await votePoll("demopoll0000000000000002", 1)).toMatchObject({ ok: false });
    expect(await votePoll("demopoll0000000000000001", 0, "Renamed option")).toMatchObject({
      ok: false,
      code: "pollOptionsChanged",
    });
  });

  it("acknowledgement: recorded once, read back as the demo user's own", async () => {
    const acked = async () =>
      (await fetchMyAnnouncementAcks()).acks.filter(
        (a) => a.targetDocumentId === "demoann00000000000000001",
      );
    if ((await acked()).length === 0) {
      expect(await acknowledgeAnnouncement("demoann00000000000000001")).toEqual({ ok: true });
    }
    expect(await acked()).toHaveLength(1);
    // Like the cms: a second receipt is refused, an announcement without one is gone.
    expect(await acknowledgeAnnouncement("demoann00000000000000001")).toMatchObject({
      ok: false,
      code: "invalid",
    });
    for (const id of ["demoann00000000000000002", "demoann00000000000000099"]) {
      expect(await acknowledgeAnnouncement(id)).toMatchObject({ ok: false, code: "notFound" });
    }
  });

  it("document acknowledgement (v0.20): recorded once, apart from the announcement receipts", async () => {
    const acked = async () =>
      (await fetchMyDocumentAcks()).acks.filter(
        (a) => a.targetDocumentId === "demodoc00000000000000001",
      );
    if ((await acked()).length === 0) {
      expect(await acknowledgeDocument("demodoc00000000000000001")).toEqual({ ok: true });
    }
    expect(await acked()).toHaveLength(1);
    expect((await fetchMyAnnouncementAcks()).acks.map((a) => a.targetType)).not.toContain(
      "document",
    );
    expect(await acknowledgeDocument("demodoc00000000000000001")).toMatchObject({
      ok: false,
      code: "invalid",
    });
    // A document without requiresAck, and an announcement's id, are gone for the caller.
    for (const id of ["demodoc00000000000000002", "demoann00000000000000001"]) {
      expect(await acknowledgeDocument(id)).toMatchObject({ ok: false, code: "notFound" });
    }
  });

  it("a read is a copy: a later write does not change what a caller holds", async () => {
    const before = await getNotifications();
    const unreadBefore = before.items.filter((n) => !n.readAt).length;
    expect(await markAllNotificationsRead()).toEqual({ ok: true });
    expect(before.items.filter((n) => !n.readAt)).toHaveLength(unreadBefore);
  });

  it("notifications: mark one read, then all", async () => {
    expect(await markNotificationsRead([1])).toEqual({ ok: true });
    expect((await getNotifications()).unreadTotal).toBeLessThanOrEqual(1);
    expect(await markAllNotificationsRead()).toEqual({ ok: true });
    expect((await getNotifications()).unreadTotal).toBe(0);
  });

  it("profile: the saved values show in the profile and the directory", async () => {
    const result = await updateProfile(
      {},
      form({ displayName: "Ada King", jobTitle: "CTO", officeLocation: "Berlin" }),
    );
    expect(result).toEqual({ success: "profileSaved" });
    const me = (await strapi<{ data: Record<string, unknown> }>("/api/me")).data;
    expect(me).toMatchObject({
      displayName: "Ada King",
      jobTitle: "CTO",
      digestFrequency: "weekly",
    });
    expect(demo("/api/users/1")).toMatchObject({
      displayName: "Ada King",
      officeLocation: "Berlin",
    });
  });

  it("training: quiz feedback and completion grade with the answer key", async () => {
    expect(
      await checkLesson("demolesson00000000000001", [{ questionIndex: 0, optionIndex: 0 }]),
    ).toEqual({
      ok: true,
      data: {
        completionMode: "quizGate",
        passed: false,
        verdicts: [{ questionIndex: 0, correct: false }],
      },
    });
    expect(
      await checkLesson("demolesson00000000000001", [{ questionIndex: 0, optionIndex: 1 }]),
    ).toMatchObject({ ok: true, data: { passed: true } });
    expect(await completeLesson("demolesson00000000000001", [0])).toMatchObject({
      ok: false,
      code: "quizFailed",
    });
    expect(await completeLesson("demolesson00000000000002", null)).toEqual({ ok: true });
    expect((await fetchMyProgress()).completed.has("demolesson00000000000002")).toBe(true);
    expect(await completeLesson("demolesson00000000000002", null)).toMatchObject({ ok: false });
  });

  it("marketplace: create, edit and delete one's own ad; another's ad is forbidden", async () => {
    const fields = {
      title: "Desk lamp",
      description: "Warm light.",
      category: "sale",
      price: "15",
    };
    await expect(createClassified({}, form(fields))).rejects.toMatchObject(
      redirectTo("/marketplace"),
    );
    const [ad] = (await api.classifieds.mine(1)).data.filter((row) => row.title === "Desk lamp");
    expect(ad).toMatchObject({ price: 15, author: { id: 1 }, images: null });
    await expect(
      updateClassified(ad!.id, {}, form({ ...fields, title: "Desk lamp (LED)" })),
    ).rejects.toMatchObject(redirectTo(`/marketplace/${ad!.id}`));
    expect((await api.classifieds.one(String(ad!.id))).data[0]?.title).toBe("Desk lamp (LED)");
    await expect(deleteClassified(ad!.id)).rejects.toMatchObject(redirectTo("/marketplace"));
    expect((await api.classifieds.mine(1)).data.some((row) => row.id === ad!.id)).toBe(false);
    // A stale tab: the deleted ad is refused like the cms's ownership policy does, and its id is not reused.
    expect(await deleteClassified(ad!.id)).toMatchObject({ ok: false, code: "forbidden" });
    await expect(createClassified({}, form(fields))).rejects.toMatchObject(
      redirectTo("/marketplace"),
    );
    const again = (await api.classifieds.mine(1)).data.find((row) => row.title === "Desk lamp");
    expect(again!.id).toBeGreaterThan(ad!.id);
    await expect(deleteClassified(again!.id)).rejects.toMatchObject(redirectTo("/marketplace"));
    expect(await deleteClassified(1)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("search telemetry is accepted without a fall-through", async () => {
    await logSearch("vpn", 3);
    expect(warnings()).toEqual([]);
  });

  it("an unknown write is a 404, with a warning", () => {
    expect(() => demo("/api/nothing-here", { method: "POST", body: "{}" })).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(warnings()).toEqual(["[demo] no fixture for POST /api/nothing-here"]);
  });
});

describe("DEMO_MODE: the data set follows the day", () => {
  it("starts afresh, dated from the new day, when the day in APP_TIME_ZONE changes", async () => {
    expect(await sendKudos(3, "Before midnight", "teamwork")).toEqual({ ok: true });
    expect((await api.kudos.list()).data[0]?.message).toBe("Before midnight");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 86_400_000);
    const kudos = (await api.kudos.list()).data;
    expect(kudos.some((k) => k.message === "Before midnight")).toBe(false);
    expect(kudos).toHaveLength(4);
  });
});
