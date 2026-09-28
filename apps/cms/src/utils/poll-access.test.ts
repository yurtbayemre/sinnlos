import { describe, expect, it } from "vitest";
import { failLikePostgres } from "./entry-id.test.helper";
import {
  loadPollViewer,
  loadPublishedPoll,
  loadUserDepartmentDocumentId,
  POLL_UID,
  USER_UID,
  type PollAccessHost,
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
