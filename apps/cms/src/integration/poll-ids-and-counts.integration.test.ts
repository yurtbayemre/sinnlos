import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestStrapi,
  testEngines,
  type Row,
  type TestRole,
  type TestStrapi,
} from "./harness.test.helper";

/**
 * Poll addressing and counting over real HTTP (batch 9, lane 4C):
 *   - DA01: vote and results take the poll's documentId (the web's address)
 *     or its published row id (the fallback); a vote by documentId lands on
 *     the published row, before and after an editor republishes the poll;
 *     a draft-only document and the draft row's id answer like a missing
 *     poll;
 *   - FX20: the results come from one GROUP BY statement; for every poll the
 *     totals equal the plain row count per option (SELECT count(*) over the
 *     joined vote rows) and the rows the query engine returns for the poll,
 *     on company-wide, targeted, guest-visible and anonymous polls.
 */

const POLL = "api::poll.poll";
const POLL_VOTE = "api::poll-vote.poll-vote";

interface Results {
  poll: { id: number; question: string };
  counts: number[];
  total: number;
  myVoteIndex: number | null;
  canVote: boolean;
}

/** The query engine's raw side, which the harness types do not name. */
interface RawDb {
  connection: { raw(sql: string, bindings?: readonly unknown[]): Promise<unknown> };
  getSchemaName(): string | undefined;
}

describe.each(testEngines())("poll ids and counts on %s", (engine) => {
  let t: TestStrapi;

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
  });

  afterAll(async () => {
    await t?.stop();
  });

  const rowIds = async (documentId: string) => {
    const rows = await t.strapi.db.query(POLL).findMany({
      where: { documentId },
      select: ["id", "publishedAt"],
    });
    return {
      draft: rows.filter((row) => row.publishedAt == null).map((row) => row.id),
      published: rows.filter((row) => row.publishedAt != null).map((row) => row.id),
    };
  };

  /** The poll row a stored vote points at. */
  const pollOfVotes = async (voter: number) =>
    (
      (await t.strapi.db.query(POLL_VOTE).findMany({
        where: { voter },
        select: ["id"],
        populate: { poll: { select: ["id"] } },
      })) as { poll?: { id?: number } | null }[]
    ).map((vote) => vote.poll?.id ?? null);

  const vote = (role: TestRole, ref: string | number, optionIndex: number) =>
    t.api<{ data?: { id?: number }; error?: { message?: string } }>(
      role,
      `/api/polls/${ref}/vote`,
      { json: { optionIndex } },
    );

  describe("DA01: documentId addressing", () => {
    let poll: Row;

    beforeAll(async () => {
      poll = await t.strapi.documents(POLL).create({
        data: { question: "IT by documentId", options: ["A", "B", "C"] },
        status: "published",
      });
    });

    it("votes by documentId on the published row, before and after a republish", async () => {
      const before = await rowIds(poll.documentId);
      expect(before.draft).toHaveLength(1);
      expect(before.published).toEqual([poll.id]);

      expect((await vote("member", poll.documentId, 1)).status).toBe(200);
      expect(await pollOfVotes(t.fixtures.users.member.id)).toEqual([poll.id]);

      await t.strapi.documents(POLL).update({
        documentId: poll.documentId,
        data: { question: "IT by documentId v2" },
      });
      await t.strapi.documents(POLL).publish({ documentId: poll.documentId });
      const after = await rowIds(poll.documentId);
      expect(after.published).toHaveLength(1);
      expect(after.published[0]).not.toBe(poll.id);

      // The same address still reaches the poll, now its new published row.
      expect((await vote("team_lead", poll.documentId, 2)).status).toBe(200);
      expect(await pollOfVotes(t.fixtures.users.team_lead.id)).toEqual(after.published);
      // The earlier vote followed the republish, so it still counts as one.
      expect(await pollOfVotes(t.fixtures.users.member.id)).toEqual(after.published);
      const again = await vote("member", poll.documentId, 0);
      expect(again.status).toBe(400);
      expect(again.body.error?.message).toBe("Already voted");

      const byDocumentId = await t.api<Results>("member", `/api/polls/${poll.documentId}/results`);
      expect(byDocumentId.status).toBe(200);
      expect(byDocumentId.body).toMatchObject({
        poll: { id: after.published[0], question: "IT by documentId v2" },
        counts: [0, 1, 1],
        total: 2,
        myVoteIndex: 1,
      });
      const byRowId = await t.api<Results>("member", `/api/polls/${after.published[0]}/results`);
      expect(byRowId.body).toEqual(byDocumentId.body);
    });

    it("answers a draft row id, the old published id and a draft-only document like a missing poll", async () => {
      const draftOnly = await t.strapi.documents(POLL).create({
        data: { question: "IT never published", options: ["A", "B"] },
      });
      const ids = await rowIds(poll.documentId);
      const missing = await t.api("member", "/api/polls/k3m9x0000000000000000999/results");
      expect(missing.status).toBe(404);
      for (const ref of [ids.draft[0], poll.id, draftOnly.documentId, draftOnly.id]) {
        const results = await t.api("member", `/api/polls/${ref}/results`);
        expect({ ref, status: results.status, body: results.body }).toEqual({
          ref,
          status: 404,
          body: missing.body,
        });
        expect((await vote("department_head", String(ref), 0)).status, String(ref)).toBe(404);
      }
    });
  });

  describe("FX20: results equal the row count per option", () => {
    const polls = {} as Record<"open" | "anonymous" | "guests" | "targeted" | "empty", Row>;
    const OPTIONS = ["A", "B", "C", "D"];

    beforeAll(async () => {
      const create = (question: string, extra: Record<string, unknown> = {}) =>
        t.strapi.documents(POLL).create({
          data: { question, options: OPTIONS, ...extra },
          status: "published",
        });
      polls.open = await create("IT count open");
      polls.anonymous = await create("IT count anonymous", { anonymous: true });
      polls.guests = await create("IT count guests", {
        visibleToGuests: true,
        guestsCanVote: true,
      });
      polls.targeted = await create("IT count engineering", {
        departments: [t.fixtures.departments.engineering.documentId],
      });
      polls.empty = await create("IT count empty");

      const ballots: [TestRole, keyof typeof polls, number][] = [
        ["member", "open", 0],
        ["team_lead", "open", 0],
        ["department_head", "open", 3],
        ["editor", "open", 0],
        ["authenticated", "open", 2],
        ["member", "anonymous", 1],
        ["team_lead", "anonymous", 1],
        ["admin_role", "anonymous", 1],
        ["guest", "guests", 2],
        ["member", "guests", 2],
        ["member", "targeted", 3],
        ["department_head", "targeted", 0],
      ];
      for (const [role, key, option] of ballots) {
        const res = await vote(role, polls[key].documentId, option);
        expect({ role, key, status: res.status }).toEqual({ role, key, status: 200 });
      }
    });

    /** SELECT count(*) per option over the poll's joined vote rows. */
    const rowCounts = async (pollId: number): Promise<number[]> => {
      const db = t.strapi.db as unknown as RawDb;
      const schema = db.getSchemaName();
      const table = (name: string) => (schema ? `${schema}.${name}` : name);
      const raw = await db.connection.raw(
        "SELECT v.option_index AS option_index, count(*) AS n FROM ?? v JOIN ?? l ON l.poll_vote_id = v.id WHERE l.poll_id = ? GROUP BY v.option_index",
        [table("poll_votes"), table("poll_votes_poll_lnk"), pollId],
      );
      const rows = (Array.isArray(raw) ? raw : (raw as { rows: unknown[] }).rows) as {
        option_index: number | string;
        n: number | string;
      }[];
      const counts = OPTIONS.map(() => 0);
      for (const row of rows) counts[Number(row.option_index)] = Number(row.n);
      return counts;
    };

    /** The same through the query engine's joined select (id kept, 0bc7830). */
    const engineCounts = async (pollId: number): Promise<number[]> => {
      const rows = await t.strapi.db.query(POLL_VOTE).findMany({
        where: { poll: pollId },
        select: ["id", "optionIndex"],
      });
      const counts = OPTIONS.map(() => 0);
      for (const row of rows) counts[Number(row.optionIndex)] += 1;
      return counts;
    };

    it("for every poll: results counts = SELECT count(*) per option = the joined select", async () => {
      for (const key of Object.keys(polls) as (keyof typeof polls)[]) {
        const res = await t.api<Results>(
          "admin_role",
          `/api/polls/${polls[key].documentId}/results`,
        );
        expect(res.status, key).toBe(200);
        const expected = await rowCounts(polls[key].id);
        expect(res.body.counts, key).toEqual(expected);
        expect(await engineCounts(polls[key].id), key).toEqual(expected);
        expect(res.body.total, key).toBe(expected.reduce((sum, n) => sum + n, 0));
      }
      const open = await t.api<Results>("member", `/api/polls/${polls.open.documentId}/results`);
      expect(open.body).toMatchObject({ counts: [3, 0, 1, 1], total: 5, myVoteIndex: 0 });
    });

    it("gives each caller their own option, also on the anonymous poll", async () => {
      const anonymous = await t.api<Results>("member", `/api/polls/${polls.anonymous.id}/results`);
      expect(anonymous.body).toMatchObject({ counts: [0, 3, 0, 0], total: 3, myVoteIndex: 1 });
      const guest = await t.api<Results>("guest", `/api/polls/${polls.guests.documentId}/results`);
      expect(guest.body).toMatchObject({ counts: [0, 0, 2, 0], myVoteIndex: 2, canVote: true });
      const none = await t.api<Results>("editor", `/api/polls/${polls.guests.documentId}/results`);
      expect(none.body.myVoteIndex).toBeNull();
    });
  });
});
