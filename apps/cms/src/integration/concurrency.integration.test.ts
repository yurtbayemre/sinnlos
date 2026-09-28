import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestStrapi,
  testEngines,
  TEST_ROLES,
  type ApiResponse,
  type Row,
  type TestRole,
  type TestStrapi,
} from "./harness.test.helper";

/**
 * Concurrent writes against the real engines. None of these may answer 5xx.
 * The races the code ACCEPTS (docs/architecture.md §7b, issue #16; no DB
 * unique constraint is possible, the user sits in a link table; DA04) are
 * pinned as what they are, so a change in behaviour shows up here:
 *   - poll vote (check-then-insert): parallel votes of ONE user may all
 *     insert a row. Each vote then deletes the voter's later rows for the
 *     poll, keeping the first (lowest id), so exactly one row stays; the
 *     request that inserted it answers 200, one whose row was a later one
 *     the 400 "Already voted" (or 200, if it looked before the first row
 *     was visible), and once the race is over the next vote is refused.
 *     The results count one ballot per voter, the first one
 *     (utils/poll-ballots.ts), so a duplicate never counts;
 *   - RSVP upsert: parallel answers of one user may store duplicate rows;
 *     the summary and the capacity gate count only the newest row per user,
 *     and the user's next answer heals the duplicates;
 *   - RSVP capacity (check-then-insert): N parallel first "yes" answers can
 *     all pass the gate, so the event can overshoot its capacity by up to
 *     N - 1; afterwards the gate holds;
 * and the one race the code closes:
 *   - reaction create (FX28): parallel identical creates collapse to ONE
 *     row, and every answer names that row.
 *
 * Observed in the lane rehearsal (2026-09-28, 8 parallel requests): SQLite
 * serialises the requests and showed no race at all (1 stored vote, 1 RSVP
 * row, 1 seat at capacity 1); Postgres 16 stored 4-8 of 8 votes of the same
 * user (varies per run; before the batch 8 integration all of them stayed
 * and counted in the results, now one stays), 8 RSVP rows, and
 * seated 5 of 5 at capacity 1. The assertions hold for every outcome in
 * between.
 */

const PARALLEL = 8;

const isServerError = (res: ApiResponse<unknown>) => res.status >= 500;

describe.each(testEngines())("concurrent writes on %s", (engine) => {
  let t: TestStrapi;

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    // Warm the JWT cache, so the parallel requests below start together.
    for (const role of TEST_ROLES) await t.loginAs(role);
  });

  afterAll(async () => {
    await t?.stop();
  });

  const createPoll = (question: string) =>
    t.strapi.documents("api::poll.poll").create({
      data: { question, options: ["A", "B"] },
      status: "published",
    });

  const createEvent = (title: string, capacity: number | null) =>
    t.strapi.documents("api::event.event").create({
      data: { title, start: "2026-11-10T09:00:00.000Z", rsvpEnabled: true, capacity },
      status: "published",
    });

  it("parallel votes of one user: no 5xx, one stored row whose vote answered 200, then refused", async () => {
    const poll = await createPoll("IT race: same voter");
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        t.api<{ data?: { id?: number }; error?: { message?: string } }>(
          "member",
          `/api/polls/${poll.id}/vote`,
          { json: { optionIndex: 1 } },
        ),
      ),
    );
    expect(responses.filter(isServerError)).toEqual([]);
    const accepted = responses.filter((res) => res.status === 200);
    const refused = responses.filter((res) => res.status === 400);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    expect(accepted.length + refused.length).toBe(PARALLEL);
    for (const res of refused) expect(res.body.error?.message).toBe("Already voted");

    // The cleanup after each insert leaves the voter's first row only, and
    // the request that inserted it was answered 200.
    const stored = (await t.strapi.db.query("api::poll-vote.poll-vote").findMany({
      where: { poll: poll.id, voter: t.fixtures.users.member.id },
      select: ["id", "optionIndex"],
    })) as Row[];
    expect(stored).toHaveLength(1);
    expect(accepted.map((res) => res.body.data?.id)).toContain(stored[0]?.id);

    const results = await t.api<{ total: number; counts: number[]; myVoteIndex: number | null }>(
      "member",
      `/api/polls/${poll.id}/results`,
    );
    // One counted ballot, however many rows the race stored.
    expect(results.body).toMatchObject({ total: 1, counts: [0, 1], myVoteIndex: 1 });
    const later = await t.api("member", `/api/polls/${poll.id}/vote`, { json: { optionIndex: 0 } });
    expect(later.status).toBe(400);
  });

  it("parallel votes of one user for different options: the first stored ballot is the one that stays and counts", async () => {
    const poll = await createPoll("IT race: same voter, two options");
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, (_, index) =>
        t.api<{ data?: { id?: number; optionIndex?: number } }>(
          "team_lead",
          `/api/polls/${poll.id}/vote`,
          { json: { optionIndex: index % 2 } },
        ),
      ),
    );
    expect(responses.filter(isServerError)).toEqual([]);
    const stored = (await t.strapi.db.query("api::poll-vote.poll-vote").findMany({
      where: { poll: poll.id, voter: t.fixtures.users.team_lead.id },
      select: ["id", "optionIndex"],
    })) as Row[];
    expect(stored).toHaveLength(1);
    const kept = responses.find((res) => res.status === 200 && res.body.data?.id === stored[0]?.id);
    expect(kept?.body.data?.optionIndex).toBe(stored[0]?.optionIndex);

    const results = await t.api<{ total: number; counts: number[]; myVoteIndex: number | null }>(
      "team_lead",
      `/api/polls/${poll.id}/results`,
    );
    const option = stored[0]?.optionIndex as number;
    expect(results.body).toMatchObject({
      total: 1,
      counts: option === 0 ? [1, 0] : [0, 1],
      myVoteIndex: option,
    });
  });

  it("stored duplicate ballots count once: the voter's first ballot wins", async () => {
    // Duplicates as a release before the cleanup on the vote path left
    // them, written straight into the table like the seed does: the
    // member's first ballot is option 0, the later ones option 1.
    const poll = await createPoll("IT race: stored duplicates");
    const votes = t.strapi.db.query("api::poll-vote.poll-vote");
    const { member, editor } = t.fixtures.users;
    for (const [voter, optionIndex] of [
      [member.id, 0],
      [editor.id, 1],
      [member.id, 1],
      [member.id, 1],
    ] as const) {
      await votes.create({ data: { poll: poll.id, optionIndex, voter } });
    }
    expect(await votes.count({ where: { poll: poll.id, voter: member.id } })).toBe(3);

    type Results = { total: number; counts: number[]; myVoteIndex: number | null };
    const asMember = await t.api<Results>("member", `/api/polls/${poll.id}/results`);
    expect(asMember.status).toBe(200);
    expect(asMember.body).toMatchObject({ total: 2, counts: [1, 1], myVoteIndex: 0 });
    const asEditor = await t.api<Results>("editor", `/api/polls/${poll.id}/results`);
    expect(asEditor.body).toMatchObject({ total: 2, counts: [1, 1], myVoteIndex: 1 });
    // The response names no voter.
    expect(asMember.text).not.toContain("voter");
  });

  it("parallel votes of different users all count", async () => {
    const poll = await createPoll("IT race: many voters");
    const voters: TestRole[] = [
      "admin_role",
      "editor",
      "department_head",
      "team_lead",
      "member",
      "authenticated",
    ];
    const responses = await Promise.all(
      voters.map((role, index) =>
        t.api(role, `/api/polls/${poll.id}/vote`, { json: { optionIndex: index % 2 } }),
      ),
    );
    expect(responses.map((res) => res.status)).toEqual(voters.map(() => 200));
    const results = await t.api<{ total: number; counts: number[] }>(
      "member",
      `/api/polls/${poll.id}/results`,
    );
    expect(results.body).toMatchObject({ total: voters.length, counts: [3, 3] });
  });

  it("parallel RSVP upserts of one user: no 5xx, counted once, healed by the next answer", async () => {
    const event = await createEvent("IT race: same attendee", null);
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, (_, index) =>
        t.api("member", "/api/event-rsvps", {
          json: {
            data: { targetDocumentId: event.documentId, status: index % 2 === 0 ? "yes" : "maybe" },
          },
        }),
      ),
    );
    expect(responses.filter(isServerError)).toEqual([]);
    expect(responses.map((res) => res.status)).toEqual(responses.map(() => 200));

    const rowsOf = () =>
      t.strapi.db.query("api::event-rsvp.event-rsvp").findMany({
        where: { targetDocumentId: event.documentId, user: t.fixtures.users.member.id },
        select: ["id", "status"],
      });
    const racedRows: Row[] = await rowsOf();
    expect(racedRows.length).toBeGreaterThanOrEqual(1);

    const summary = await t.api<{ data: { yesCount: number; maybeCount: number }[] }>(
      "member",
      `/api/event-rsvps/summary?targets=${event.documentId}`,
    );
    const [counts] = summary.body.data;
    expect(counts.yesCount + counts.maybeCount).toBe(1);

    const heal = await t.api("member", "/api/event-rsvps", {
      json: { data: { targetDocumentId: event.documentId, status: "no" } },
    });
    expect(heal.status).toBe(200);
    const healed = await rowsOf();
    expect(healed.map((row) => row.status)).toEqual(["no"]);
  });

  it("parallel first 'yes' answers at capacity 1: no 5xx, overshoot bounded, then the gate holds", async () => {
    const event = await createEvent("IT race: one seat", 1);
    const racers: TestRole[] = [
      "editor",
      "department_head",
      "team_lead",
      "member",
      "authenticated",
    ];
    const responses = await Promise.all(
      racers.map((role) =>
        t.api<{ error?: { message?: string } }>(role, "/api/event-rsvps", {
          json: { data: { targetDocumentId: event.documentId, status: "yes" } },
        }),
      ),
    );
    expect(responses.filter(isServerError)).toEqual([]);
    const seated = responses.filter((res) => res.status === 200).length;
    const full = responses.filter((res) => res.status === 400);
    expect(seated).toBeGreaterThanOrEqual(1);
    expect(seated).toBeLessThanOrEqual(racers.length);
    expect(seated + full.length).toBe(racers.length);
    for (const res of full) expect(res.body.error?.message).toBe("Event is at capacity");

    const summary = await t.api<{ data: { yesCount: number }[] }>(
      "admin_role",
      `/api/event-rsvps/summary?targets=${event.documentId}`,
    );
    expect(summary.body.data[0].yesCount).toBe(seated);
    // After the race the gate holds for the next newcomer.
    const late = await t.api("admin_role", "/api/event-rsvps", {
      json: { data: { targetDocumentId: event.documentId, status: "yes" } },
    });
    expect(late.status).toBe(400);
  });

  it("parallel identical reaction creates collapse to one row that every answer names", async () => {
    const announcement = await t.strapi.documents("api::announcement.announcement").create({
      data: { title: "IT race: reactions", audience: "all" },
      status: "published",
    });
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        t.api<{ data?: { id?: number } }>("member", "/api/reactions", {
          json: {
            data: {
              emoji: "heart",
              targetType: "announcement",
              targetDocumentId: announcement.documentId,
              reacted: true,
            },
          },
        }),
      ),
    );
    expect(responses.filter(isServerError)).toEqual([]);
    expect(responses.every((res) => res.status === 200 || res.status === 201)).toBe(true);
    const rows = await t.strapi.db.query("api::reaction.reaction").findMany({
      where: { targetDocumentId: announcement.documentId },
      select: ["id"],
    });
    expect(rows).toHaveLength(1);
    expect(new Set(responses.map((res) => res.body.data?.id))).toEqual(new Set([rows[0].id]));
  });
});
