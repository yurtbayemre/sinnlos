import { describe, expect, it } from "vitest";
import { MALFORMED_ENTRY_IDS, failLikePostgres } from "./entry-id.test.helper";
import {
  loadPollViewer,
  loadPublishedPoll,
  loadPublishedPolls,
  loadUserDepartmentDocumentId,
  parsePollRefs,
  pollOptionCount,
  pollResultsBody,
  POLL_UID,
  USER_UID,
  type PollAccessHost,
  type PollListHost,
  type PublishedPoll,
} from "./poll-access";

/**
 * DB loaders of poll targeting (decision 02). The stubs record every
 * query, so the pins that matter are asserted on the query itself: the
 * published-only `where` and the documentId-based department lookup. They
 * also fail like Postgres on an `id` an int4 column cannot hold, so a
 * route id that slips past `parseEntryRef` fails here as it did in
 * production.
 */

/** A documentId in Strapi's shape: the poll address the web sends (DA01). */
const POLL_DOCUMENT_ID = "lj5n10lqpweysvb5m9hmiv8p";

function host(rows: Partial<Record<string, unknown>>) {
  const queries: { uid: string; params: Record<string, unknown> }[] = [];
  const strapi: PollAccessHost = {
    db: {
      query: (uid: string) => ({
        findOne: async (params: Record<string, unknown>) => {
          queries.push({ uid, params });
          failLikePostgres(params.where);
          return rows[uid] ?? null;
        },
      }),
    },
  };
  return { strapi, queries };
}

describe("loadUserDepartmentDocumentId", () => {
  it("reads the caller's department documentId through the user row", async () => {
    const { strapi, queries } = host({ [USER_UID]: { id: 5, department: { documentId: "d-eng" } } });
    await expect(loadUserDepartmentDocumentId(strapi, 5)).resolves.toBe("d-eng");
    expect(queries).toEqual([
      {
        uid: USER_UID,
        params: {
          where: { id: 5 },
          select: ["id"],
          populate: { department: { select: ["documentId"] } },
        },
      },
    ]);
  });

  it("is null without a department, a user row or a usable documentId", async () => {
    for (const row of [
      { id: 5, department: null },
      { id: 5 },
      null,
      { id: 5, department: { documentId: "" } },
      { id: 5, department: { documentId: 7 } },
    ]) {
      const { strapi } = host({ [USER_UID]: row });
      await expect(loadUserDepartmentDocumentId(strapi, 5), JSON.stringify(row)).resolves.toBeNull();
    }
  });
});

describe("loadPollViewer", () => {
  it("takes the role from ctx.state.user and the department from the database", async () => {
    const { strapi } = host({ [USER_UID]: { id: 5, department: { documentId: "d-eng" } } });
    await expect(loadPollViewer(strapi, { id: 5, role: { type: "guest" } })).resolves.toEqual({
      roleType: "guest",
      departmentDocumentId: "d-eng",
    });
  });

  it("gives a user without a populated role a null role type", async () => {
    const { strapi } = host({});
    await expect(loadPollViewer(strapi, { id: 5 })).resolves.toEqual({
      roleType: null,
      departmentDocumentId: null,
    });
  });
});

describe("loadPublishedPoll: the route reference (parseEntryRef, utils/entry-id.ts)", () => {
  it("looks up a documentId, pinned to the published row (DA01)", async () => {
    const { strapi, queries } = host({});
    await loadPublishedPoll(strapi, POLL_DOCUMENT_ID);
    expect(queries.map((query) => query.params.where)).toEqual([
      { documentId: POLL_DOCUMENT_ID, publishedAt: { $notNull: true } },
    ]);
  });

  it("looks up a plain positive decimal row id, as a string or a number (the fallback)", async () => {
    const accepted: [unknown, number][] = [
      ["1", 1],
      ["2147483647", 2147483647],
      [42, 42],
    ];
    for (const [raw, id] of accepted) {
      const { strapi, queries } = host({});
      await loadPublishedPoll(strapi, raw);
      expect(
        queries.map((query) => query.params.where),
        String(raw),
      ).toEqual([{ id, publishedAt: { $notNull: true } }]);
    }
  });

  it("answers null without a query for anything else", async () => {
    for (const raw of [
      "0",
      "-1",
      "01",
      "1.5",
      "1e3",
      " 1",
      "abc",
      "",
      "2147483648",
      "99999999999",
      "k3x9documentid",
      POLL_DOCUMENT_ID.toUpperCase(),
      `${POLL_DOCUMENT_ID}x`,
      ` ${POLL_DOCUMENT_ID}`,
      undefined,
      null,
      0,
      1.5,
      -3,
      2147483648,
      {},
    ]) {
      const { strapi, queries } = host({ [POLL_UID]: { id: 12 } });
      await expect(loadPublishedPoll(strapi, raw), String(raw)).resolves.toBeNull();
      expect(queries, String(raw)).toEqual([]);
    }
  });
});

describe("loadPublishedPoll", () => {
  const row = {
    id: 12,
    documentId: "poll-doc",
    question: "Pizza?",
    options: ["yes", "no"],
    closesAt: "2026-09-30T21:59:59.000Z",
    anonymous: true,
    audience: "departments",
    departments: [{ documentId: "d-eng", name: "Engineering" }],
    visibleToGuests: true,
    guestsCanVote: false,
  };

  it("pins the lookup to the published row and loads the targeting and guest fields", async () => {
    const { strapi, queries } = host({ [POLL_UID]: row });
    await expect(loadPublishedPoll(strapi, "12")).resolves.toEqual(row);
    expect(queries).toEqual([
      {
        uid: POLL_UID,
        params: {
          where: { id: 12, publishedAt: { $notNull: true } },
          select: [
            "id",
            "documentId",
            "question",
            "options",
            "closesAt",
            "anonymous",
            "audience",
            "visibleToGuests",
            "guestsCanVote",
          ],
          populate: { departments: { select: ["documentId", "name"] } },
        },
      },
    ]);
  });

  it("reads the guest flags as strict booleans: only true is true (fail closed)", async () => {
    for (const value of [null, undefined, false, 1, "true", "1"]) {
      const { strapi } = host({ [POLL_UID]: { ...row, visibleToGuests: value, guestsCanVote: value } });
      const poll = await loadPublishedPoll(strapi, "12");
      expect(poll?.visibleToGuests, String(value)).toBe(false);
      expect(poll?.guestsCanVote, String(value)).toBe(false);
    }
    const { strapi } = host({ [POLL_UID]: { ...row, visibleToGuests: true, guestsCanVote: true } });
    await expect(loadPublishedPoll(strapi, "12")).resolves.toMatchObject({
      visibleToGuests: true,
      guestsCanVote: true,
    });
  });

  it("answers null when no published row matches (missing, draft id, draft-only document)", async () => {
    const { strapi } = host({});
    await expect(loadPublishedPoll(strapi, "12")).resolves.toBeNull();
    await expect(loadPublishedPoll(strapi, POLL_DOCUMENT_ID)).resolves.toBeNull();
  });

  it("returns the published row's id for a documentId, the id a vote stores", async () => {
    const published = { ...row, id: 31, documentId: POLL_DOCUMENT_ID };
    const { strapi, queries } = host({ [POLL_UID]: published });
    await expect(loadPublishedPoll(strapi, POLL_DOCUMENT_ID)).resolves.toMatchObject({
      id: 31,
      documentId: POLL_DOCUMENT_ID,
    });
    expect(queries[0]?.params).toMatchObject({
      where: { documentId: POLL_DOCUMENT_ID, publishedAt: { $notNull: true } },
      select: expect.arrayContaining(["id", "documentId"]),
    });
  });

  it("normalises a legacy row (NULL flag, no departments, no guest columns)", async () => {
    const { strapi } = host({
      [POLL_UID]: { id: 3, documentId: "d", question: "q", options: [], closesAt: null, anonymous: null, audience: null },
    });
    await expect(loadPublishedPoll(strapi, 3)).resolves.toEqual({
      id: 3,
      documentId: "d",
      question: "q",
      options: [],
      closesAt: null,
      anonymous: null,
      audience: null,
      departments: [],
      visibleToGuests: false,
      guestsCanVote: false,
    });
  });
});

// ---------------------------------------------------------------------------
// The batched results (WD04): GET /api/poll-results
// ---------------------------------------------------------------------------

const DOC_A = "k3m9x0000000000000000001";
const DOC_B = "k3m9x0000000000000000002";

describe("parsePollRefs", () => {
  it("reads documentIds and row ids, comma-separated or repeated, in order, each once", () => {
    expect(parsePollRefs(`${DOC_A},12,${DOC_B}`)).toEqual({
      refs: [{ documentId: DOC_A }, { id: 12 }, { documentId: DOC_B }],
    });
    expect(parsePollRefs([DOC_A, `12,${DOC_A}`, "12"])).toEqual({
      refs: [{ documentId: DOC_A }, { id: 12 }],
    });
  });

  it("refuses a missing, empty, malformed or over-long list", () => {
    expect(parsePollRefs(undefined)).toEqual({ error: "ids required" });
    expect(parsePollRefs([])).toEqual({ error: "ids required" });
    for (const raw of [
      "",
      ",",
      `${DOC_A},`,
      12,
      { $in: [1] },
      [DOC_A, 7],
      ...MALFORMED_ENTRY_IDS,
    ]) {
      expect(parsePollRefs(raw), JSON.stringify(raw)).toEqual({ error: "Invalid ids" });
    }
    const ids = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1)).join(",");
    expect(parsePollRefs(ids(50))).toMatchObject({ refs: expect.any(Array) });
    expect(parsePollRefs(ids(51))).toEqual({ error: "At most 50 ids" });
    // Duplicates do not count towards the cap.
    expect(parsePollRefs(`${ids(50)},1,2`)).toMatchObject({ refs: expect.any(Array) });
  });
});

describe("loadPublishedPolls", () => {
  const rowOf = (id: number, documentId: string) => ({
    id,
    documentId,
    question: `Poll ${id}`,
    options: ["a", "b"],
    closesAt: null,
    anonymous: false,
    audience: "all",
    departments: [],
    visibleToGuests: false,
    guestsCanVote: false,
  });

  function listHost(rows: unknown[]) {
    const queries: Record<string, unknown>[] = [];
    const strapi: PollListHost = {
      db: {
        query: (uid: string) => ({
          findMany: async (params: Record<string, unknown>) => {
            expect(uid).toBe(POLL_UID);
            queries.push(params);
            return rows;
          },
        }),
      },
    };
    return { strapi, queries };
  }

  it("reads the published rows of every address in ONE query", async () => {
    const { strapi, queries } = listHost([rowOf(12, DOC_B), rowOf(31, DOC_A)]);
    const polls = await loadPublishedPolls(strapi, [{ documentId: DOC_A }, { id: 12 }]);
    expect(polls.map((poll) => poll.id)).toEqual([31, 12]);
    expect(queries).toEqual([
      {
        where: {
          publishedAt: { $notNull: true },
          $or: [{ id: { $in: [12] } }, { documentId: { $in: [DOC_A] } }],
        },
        select: expect.arrayContaining(["id", "documentId", "options", "visibleToGuests"]),
        populate: { departments: { select: ["documentId", "name"] } },
      },
    ]);
  });

  it("lists a poll once when its id and its documentId are both asked, and drops unknown ones", async () => {
    const { strapi } = listHost([rowOf(12, DOC_A), { id: "x" }, null]);
    const polls = await loadPublishedPolls(strapi, [
      { id: 12 },
      { documentId: DOC_A },
      { documentId: DOC_B },
      { id: 99 },
    ]);
    expect(polls.map((poll) => poll.id)).toEqual([12]);
  });

  it("asks only for the kinds of address it got, and nothing for none", async () => {
    const onlyIds = listHost([]);
    await loadPublishedPolls(onlyIds.strapi, [{ id: 1 }, { id: 2 }]);
    expect(onlyIds.queries[0]?.where).toEqual({
      publishedAt: { $notNull: true },
      $or: [{ id: { $in: [1, 2] } }],
    });
    const none = listHost([]);
    await expect(loadPublishedPolls(none.strapi, [])).resolves.toEqual([]);
    expect(none.queries).toEqual([]);
  });
});

describe("pollResultsBody", () => {
  const poll: PublishedPoll = {
    id: 12,
    documentId: DOC_A,
    question: "Pizza?",
    options: ["yes", "no", "maybe"],
    closesAt: null,
    anonymous: null,
    audience: "departments",
    departments: [
      { documentId: "d-eng", name: "Engineering" },
      { documentId: null, name: "Gone" },
      { documentId: "d-ops", name: null },
    ],
    visibleToGuests: true,
    guestsCanVote: false,
  };
  const tally = { counts: [1, 2, 0], total: 3, myVoteIndex: 1 };

  it("carries the question, options, counts, the caller's vote, canVote, audience and guest flags", () => {
    const member = { roleType: "member", departmentDocumentId: "d-eng" };
    expect(pollResultsBody(poll, tally, member)).toEqual({
      poll: {
        id: 12,
        documentId: DOC_A,
        question: "Pizza?",
        options: ["yes", "no", "maybe"],
        closesAt: null,
        anonymous: false,
        visibleToGuests: true,
        guestsCanVote: false,
      },
      counts: [1, 2, 0],
      total: 3,
      myVoteIndex: 1,
      canVote: true,
      audience: {
        targeted: true,
        departments: [
          { documentId: "d-eng", name: "Engineering" },
          { documentId: "d-ops", name: "" },
        ],
      },
    });
  });

  it("decides canVote per caller: outside the audience and a guest without guest voting cannot", () => {
    const canVote = (roleType: string, departmentDocumentId: string | null) =>
      pollResultsBody(poll, tally, { roleType, departmentDocumentId }).canVote;
    expect(canVote("editor", null)).toBe(false);
    expect(canVote("guest", "d-eng")).toBe(false);
  });

  it("counts the options of a list only", () => {
    expect(pollOptionCount(poll)).toBe(3);
    expect(pollOptionCount({ ...poll, options: "yes,no" })).toBe(0);
    expect(pollResultsBody({ ...poll, options: null }, tally, null).poll.options).toEqual([]);
  });
});
