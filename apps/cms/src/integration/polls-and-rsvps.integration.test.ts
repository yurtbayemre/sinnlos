import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestStrapi,
  testEngines,
  type Row,
  type TestRole,
  type TestStrapi,
} from "./harness.test.helper";

/**
 * Personal and audience-bound reads over real HTTP:
 *   - guest poll exposure (owner decision 2026-09-27): a guest sees only
 *     polls with `visibleToGuests`, votes only where `guestsCanVote` is set
 *     too, and a hidden poll answers exactly like a missing one (list, read,
 *     results and vote; no existence oracle);
 *   - RSVPs (FX21, batch 7): the raw reads return the caller's own rows only
 *     (admin_role: all), a user filter is refused, and the summary counts
 *     every answer but names only the "yes" answers, never a decliner.
 */

interface PollResults {
  counts: number[];
  total: number;
  myVoteIndex: number | null;
  canVote: boolean;
}

interface RsvpSummary {
  targetDocumentId: string;
  yesCount: number;
  maybeCount: number;
  noCount: number;
  yesNames: string[];
  myStatus: string | null;
}

describe.each(testEngines())("polls and RSVPs on %s", (engine) => {
  let t: TestStrapi;

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
  });

  afterAll(async () => {
    await t?.stop();
  });

  describe("guest poll exposure (visibleToGuests / guestsCanVote)", () => {
    const polls = {} as Record<"hidden" | "readOnly" | "votable" | "targeted", Row>;

    beforeAll(async () => {
      const create = (question: string, extra: Record<string, unknown>) =>
        t.strapi.documents("api::poll.poll").create({
          data: { question, options: ["A", "B", "C"], ...extra },
          status: "published",
        });
      polls.hidden = await create("IT hidden from guests", {});
      polls.readOnly = await create("IT guests read", { visibleToGuests: true });
      polls.votable = await create("IT guests vote", {
        visibleToGuests: true,
        guestsCanVote: true,
      });
      // Visible to guests, but targeted at a department no guest belongs to.
      polls.targeted = await create("IT engineering only", {
        visibleToGuests: true,
        guestsCanVote: true,
        departments: [t.fixtures.departments.engineering.documentId],
      });
    });

    it("the guest list holds exactly the polls opened to guests", async () => {
      const res = await t.api<{ data: { question: string }[] }>(
        "guest",
        "/api/polls?pagination[pageSize]=100",
      );
      expect(res.status).toBe(200);
      expect(res.body.data.map((poll) => poll.question).sort()).toEqual([
        "IT guests read",
        "IT guests vote",
      ]);
    });

    it("staff see every company-wide poll and the one targeted at their department", async () => {
      const res = await t.api<{ data: { question: string }[] }>(
        "member",
        "/api/polls?pagination[pageSize]=100",
      );
      expect(res.body.data.map((poll) => poll.question).sort()).toEqual([
        "IT engineering only",
        "IT guests read",
        "IT guests vote",
        "IT hidden from guests",
      ]);
    });

    it("a hidden poll answers like a missing one: findOne, results and vote", async () => {
      const missingId = 2_000_000;
      for (const poll of [polls.hidden, polls.targeted]) {
        expect((await t.api("guest", `/api/polls/${poll.documentId}`)).status).toBe(404);

        const results = await t.api("guest", `/api/polls/${poll.id}/results`);
        const missingResults = await t.api("guest", `/api/polls/${missingId}/results`);
        expect({ status: results.status, body: results.body }).toEqual({
          status: missingResults.status,
          body: missingResults.body,
        });
        expect(results.status).toBe(404);

        const vote = await t.api("guest", `/api/polls/${poll.id}/vote`, {
          json: { optionIndex: 0 },
        });
        const missingVote = await t.api("guest", `/api/polls/${missingId}/vote`, {
          json: { optionIndex: 0 },
        });
        expect({ status: vote.status, body: vote.body }).toEqual({
          status: missingVote.status,
          body: missingVote.body,
        });
      }
    });

    it("guestsCanVote off: the guest reads the results but cannot vote", async () => {
      const results = await t.api<PollResults>("guest", `/api/polls/${polls.readOnly.id}/results`);
      expect(results.status).toBe(200);
      expect(results.body.canVote).toBe(false);
      const vote = await t.api("guest", `/api/polls/${polls.readOnly.id}/vote`, {
        json: { optionIndex: 1 },
      });
      expect(vote.status).toBe(403);
      expect(vote.text).toContain("Guests cannot vote on this poll");
    });

    it("guestsCanVote on: the guest votes once, and the vote is counted", async () => {
      const vote = await t.api("guest", `/api/polls/${polls.votable.id}/vote`, {
        json: { optionIndex: 2 },
      });
      expect(vote.status).toBe(200);
      const again = await t.api("guest", `/api/polls/${polls.votable.id}/vote`, {
        json: { optionIndex: 0 },
      });
      expect(again.status).toBe(400);
      const results = await t.api<PollResults>("guest", `/api/polls/${polls.votable.id}/results`);
      expect(results.body).toMatchObject({
        counts: [0, 0, 1],
        total: 1,
        myVoteIndex: 2,
        canVote: true,
      });
      // Results never name a voter.
      expect(results.text).not.toContain(t.fixtures.users.guest.username);
      expect(results.text).not.toContain(t.fixtures.users.guest.displayName);
    });
  });

  describe("RSVPs: own rows only, and a summary without decliner names (FX21)", () => {
    let event: Row;
    const answers: ReadonlyArray<readonly [TestRole, "yes" | "maybe" | "no"]> = [
      ["member", "yes"],
      ["team_lead", "no"],
      ["department_head", "maybe"],
      ["editor", "yes"],
    ];

    beforeAll(async () => {
      event = await t.strapi.documents("api::event.event").create({
        data: { title: "IT Offsite", start: "2026-11-02T09:00:00.000Z", rsvpEnabled: true },
        status: "published",
      });
      for (const [role, status] of answers) {
        const res = await t.api(role, "/api/event-rsvps", {
          json: { data: { targetDocumentId: event.documentId, status } },
        });
        expect({ role, status: res.status }).toEqual({ role, status: 200 });
      }
    });

    type RsvpList = {
      data: { id: number; documentId: string; status: string; user?: { id: number } | null }[];
    };

    it("GET /api/event-rsvps returns the caller's own row only", async () => {
      for (const [role, status] of answers) {
        const res = await t.api<RsvpList>(role, "/api/event-rsvps?populate[user][fields][0]=id");
        expect(res.status).toBe(200);
        expect(res.body.data.map((row) => [row.status, row.user?.id])).toEqual([
          [status, t.fixtures.users[role].id],
        ]);
      }
    });

    it("another user's row is a 404, and a user filter is refused", async () => {
      const [theirs] = (await t.api<RsvpList>("team_lead", "/api/event-rsvps")).body.data;
      expect((await t.api("member", `/api/event-rsvps/${theirs.documentId}`)).status).toBe(404);
      const filtered = await t.api(
        "member",
        `/api/event-rsvps?filters[user][id][$eq]=${t.fixtures.users.team_lead.id}`,
      );
      expect(filtered.status).toBe(400);
      const legacy = await t.api("member", "/api/event-rsvps", {
        headers: { "Strapi-Response-Format": "v4" },
      });
      expect(legacy.status).toBe(400);
    });

    it("admin_role reads every row", async () => {
      const res = await t.api<RsvpList>("admin_role", "/api/event-rsvps?pagination[pageSize]=100");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(answers.length);
    });

    it("the summary counts every answer and names the yes answers only", async () => {
      for (const [role, status] of answers) {
        const res = await t.api<{ data: RsvpSummary[] }>(
          role,
          `/api/event-rsvps/summary?targets=${event.documentId}`,
        );
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([
          {
            targetDocumentId: event.documentId,
            yesCount: 2,
            maybeCount: 1,
            noCount: 1,
            yesNames: [t.fixtures.users.member.displayName, t.fixtures.users.editor.displayName],
            myStatus: status,
          },
        ]);
        // No decliner name anywhere in the answer.
        expect(res.text).not.toContain(t.fixtures.users.team_lead.displayName);
        expect(res.text).not.toContain(t.fixtures.users.department_head.displayName);
      }
    });

    it("guest holds no RSVP grant at all", async () => {
      expect((await t.api("guest", "/api/event-rsvps")).status).toBe(403);
      expect(
        (await t.api("guest", `/api/event-rsvps/summary?targets=${event.documentId}`)).status,
      ).toBe(403);
      const create = await t.api("guest", "/api/event-rsvps", {
        json: { data: { targetDocumentId: event.documentId, status: "yes" } },
      });
      expect(create.status).toBe(403);
    });
  });
});
