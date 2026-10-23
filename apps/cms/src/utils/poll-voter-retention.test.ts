import { describe, expect, it } from "vitest";

import { createStrapiStub, type Row } from "../test/strapi-stub.test.helper";
import {
  POLL_VOTER_RETENTION_DAYS,
  ballotPlan,
  duePolls,
  votersRemovable,
  type PollVoterJanitorStrapi,
} from "./poll-voter-retention";

/**
 * Poll voter links (v0.28, owner decision 2026-10-23): 30 days after the
 * close, over every row of the poll. The transaction, the lock and the
 * unchanged results are pinned on both engines in
 * integration/retention-v028.integration.test.ts.
 */

const NOW = new Date("2026-11-01T02:56:00.000Z");
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

describe("votersRemovable (pure)", () => {
  it("is 30 days after the close", () => {
    expect(POLL_VOTER_RETENTION_DAYS).toBe(30);
    expect(votersRemovable([{ closesAt: daysAgo(30.01) }], NOW)).toBe(true);
    expect(votersRemovable([{ closesAt: daysAgo(30) }], NOW)).toBe(false);
    expect(votersRemovable([{ closesAt: daysAgo(3) }], NOW)).toBe(false);
  });

  it("needs every row closed long ago: a draft or published row still open keeps the links", () => {
    expect(votersRemovable([{ closesAt: daysAgo(60) }, { closesAt: daysAgo(40) }], NOW)).toBe(true);
    expect(votersRemovable([{ closesAt: daysAgo(60) }, { closesAt: daysAgo(10) }], NOW)).toBe(
      false,
    );
    expect(votersRemovable([{ closesAt: daysAgo(60) }, { closesAt: null }], NOW)).toBe(false);
  });

  it("keeps the links of a poll that never closes, of unreadable dates and of no rows", () => {
    for (const rows of [
      [{ closesAt: null }],
      [{ closesAt: undefined }],
      [{ closesAt: "" }],
      [{ closesAt: "last month" }],
      [{ closesAt: 12345 }],
      [],
    ]) {
      expect(votersRemovable(rows, NOW), JSON.stringify(rows)).toBe(false);
    }
  });

  it("accepts Date values, and is done once every row carries votersRemovedAt", () => {
    expect(votersRemovable([{ closesAt: new Date(daysAgo(40)) }], NOW)).toBe(true);
    const stamped = { closesAt: daysAgo(40), votersRemovedAt: daysAgo(5) };
    expect(votersRemovable([stamped, stamped], NOW)).toBe(false);
    expect(votersRemovable([stamped, { closesAt: daysAgo(40) }], NOW)).toBe(true);
  });
});

describe("ballotPlan (pure)", () => {
  it("keeps each voter's first ballot, deletes the later ones, leaves voterless rows alone", () => {
    expect(
      ballotPlan([
        { id: 5, voterId: 2 },
        { id: 1, voterId: 1 },
        { id: 3, voterId: 1 },
        { id: 4, voterId: null },
        { id: 2, voterId: 2 },
        { id: 9, voterId: 1 },
      ]),
    ).toEqual({ deleteIds: [3, 5, 9], unlinkIds: [1, 2] });
  });

  it("does nothing for no votes", () => {
    expect(ballotPlan([])).toEqual({ deleteIds: [], unlinkIds: [] });
  });
});

describe("duePolls: the rule before the cap (Codex review of lane A3)", () => {
  it("finds a due poll behind more kept polls than any cap, and never a kept one", async () => {
    const POLL = "api::poll.poll";
    const rows: Row[] = [];
    let id = 0;
    // 600 polls whose published row closed long ago but whose draft is still open.
    for (let i = 0; i < 600; i += 1) {
      rows.push({
        id: ++id,
        documentId: `kept${i}`,
        publishedAt: daysAgo(90),
        closesAt: daysAgo(40),
      });
      rows.push({ id: ++id, documentId: `kept${i}`, publishedAt: null, closesAt: null });
    }
    rows.push({ id: ++id, documentId: "due", publishedAt: daysAgo(90), closesAt: daysAgo(40) });
    rows.push({ id: ++id, documentId: "due", publishedAt: null, closesAt: daysAgo(40) });
    const strapi = createStrapiStub({ tables: { [POLL]: rows } });
    await expect(duePolls(strapi as unknown as PollVoterJanitorStrapi, NOW)).resolves.toEqual([
      "due",
    ]);
  });
});
