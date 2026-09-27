import { describe, expect, it } from "vitest";
import {
  loadPollViewer,
  loadPublishedPoll,
  loadUserDepartmentDocumentId,
  parsePollRowId,
  POLL_UID,
  USER_UID,
  type PollAccessHost,
} from "./poll-access";

/**
 * DB loaders of poll targeting (decision 02). The stubs record every
 * query, so the pins that matter are asserted on the query itself: the
 * published-only `where` and the documentId-based department lookup.
 */

function host(rows: Partial<Record<string, unknown>>) {
  const queries: { uid: string; params: Record<string, unknown> }[] = [];
  const strapi: PollAccessHost = {
    db: {
      query: (uid: string) => ({
        findOne: async (params: Record<string, unknown>) => {
          queries.push({ uid, params });
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

describe("parsePollRowId", () => {
  it("accepts plain positive decimal row ids", () => {
    expect(parsePollRowId("1")).toBe(1);
    expect(parsePollRowId("2147483647")).toBe(2147483647);
    expect(parsePollRowId(42)).toBe(42);
  });

  it("refuses everything else, including ids beyond the integer column", () => {
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
      undefined,
      null,
      1.5,
      -3,
      {},
    ]) {
      expect(parsePollRowId(raw), String(raw)).toBeNull();
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
  };

  it("pins the lookup to the published row and loads the targeting fields", async () => {
    const { strapi, queries } = host({ [POLL_UID]: row });
    await expect(loadPublishedPoll(strapi, "12")).resolves.toEqual(row);
    expect(queries).toEqual([
      {
        uid: POLL_UID,
        params: {
          where: { id: 12, publishedAt: { $notNull: true } },
          select: ["id", "documentId", "question", "options", "closesAt", "anonymous", "audience"],
          populate: { departments: { select: ["documentId", "name"] } },
        },
      },
    ]);
  });

  it("does not query for a malformed id", async () => {
    for (const raw of ["abc", "0", "-1", "1.5", "2147483648", undefined]) {
      const { strapi, queries } = host({ [POLL_UID]: row });
      await expect(loadPublishedPoll(strapi, raw), String(raw)).resolves.toBeNull();
      expect(queries).toEqual([]);
    }
  });

  it("answers null when no published row matches (missing or draft id)", async () => {
    const { strapi } = host({});
    await expect(loadPublishedPoll(strapi, "12")).resolves.toBeNull();
  });

  it("normalises a legacy row (NULL flag, no departments)", async () => {
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
    });
  });
});
