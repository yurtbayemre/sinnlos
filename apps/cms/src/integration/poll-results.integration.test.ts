import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  TEST_ROLES,
  createTestStrapi,
  testEngines,
  type Row,
  type TestRole,
  type TestStrapi,
} from "./harness.test.helper";

/**
 * The batched poll results (WD04, batch 10 lane 5C) over real HTTP, on
 * SQLite and (with SINNLOS_TEST_PG_URL) Postgres 16:
 *   - GET /api/poll-results?ids= answers, for every role, exactly the polls
 *     the single GET /api/polls/:id/results answers, with the identical
 *     body, in the order asked; a draft, a draft-only document, a missing id
 *     and a poll the caller may not see (another department's, one hidden
 *     from guests) are all simply absent (no existence oracle);
 *   - the counts are the first ballot of each voter (the same GROUP BY rule
 *     as the single read), also after a republish (documentId address);
 *   - the bootstrap grants the new action to every intranet role and the
 *     `authenticated` fallback, never to `public` (403 without a JWT);
 *   - a malformed or over-long id list is a 400.
 */

interface Results {
  poll: { id: number; documentId?: string; question: string };
  counts: number[];
  total: number;
  myVoteIndex: number | null;
  canVote: boolean;
}

const POLL = "api::poll.poll";
const BATCH_ACTION = "api::poll.poll.batchResults";

describe.each(testEngines())("batched poll results on %s", (engine) => {
  let t: TestStrapi;
  const polls = {} as Record<
    "open" | "engineering" | "sales" | "guestsRead" | "guestsVote" | "hidden",
    Row
  >;
  let draftOnly: Row;
  /** Every address a caller may send: documentIds, row ids, a draft row, missing ones. */
  let addresses: string[];

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    const create = (question: string, extra: Record<string, unknown> = {}, publish = true) =>
      t.strapi.documents(POLL).create({
        data: { question, options: ["A", "B", "C"], ...extra },
        ...(publish ? { status: "published" } : {}),
      });
    polls.open = await create("IT batch open");
    polls.engineering = await create("IT batch engineering", {
      departments: [t.fixtures.departments.engineering.documentId],
    });
    polls.sales = await create("IT batch sales", {
      departments: [t.fixtures.departments.sales.documentId],
    });
    polls.guestsRead = await create("IT batch guests read", { visibleToGuests: true });
    polls.guestsVote = await create("IT batch guests vote", {
      visibleToGuests: true,
      guestsCanVote: true,
    });
    polls.hidden = await create("IT batch hidden from guests");
    draftOnly = await create("IT batch never published", {}, false);

    const ballots: [TestRole, keyof typeof polls, number][] = [
      ["member", "open", 0],
      ["team_lead", "open", 1],
      ["editor", "open", 1],
      ["authenticated", "open", 2],
      ["member", "engineering", 2],
      ["department_head", "engineering", 2],
      ["guest", "guestsVote", 1],
      ["member", "guestsVote", 0],
    ];
    for (const [role, key, optionIndex] of ballots) {
      const res = await t.api(role, `/api/polls/${polls[key].documentId}/vote`, {
        json: { optionIndex },
      });
      expect({ role, key, status: res.status }).toEqual({ role, key, status: 200 });
    }
    // A second ballot of the same voter never counts (one ballot per voter).
    expect(
      (
        await t.api("member", `/api/polls/${polls.open.documentId}/vote`, {
          json: { optionIndex: 2 },
        })
      ).status,
    ).toBe(400);

    const draftRows = await t.strapi.db.query(POLL).findMany({
      where: { publishedAt: { $null: true } },
      select: ["id"],
    });
    addresses = [
      ...Object.values(polls).flatMap((poll) => [poll.documentId, String(poll.id)]),
      draftOnly.documentId,
      ...draftRows.map((row) => String(row.id)),
      "k3m9x0000000000000000999",
      "2000000",
    ];
  });

  afterAll(async () => {
    await t?.stop();
  });

  const batch = (caller: TestRole | null, ids: string) =>
    t.api<{ data: Results[]; error?: { message?: string } }>(
      caller,
      `/api/poll-results?ids=${encodeURIComponent(ids)}`,
    );

  it("the bootstrap granted the action to every intranet role and authenticated, not public", async () => {
    const rows = await t.strapi.db.query("plugin::users-permissions.permission").findMany({
      where: { action: BATCH_ACTION },
      populate: { role: { select: ["type"] } },
    });
    const holders = rows
      .map((row) => (row.role as { type?: string } | null)?.type)
      .filter((type): type is string => typeof type === "string")
      .sort();
    expect(holders).toEqual([...TEST_ROLES].sort());
    const anonymous = await batch(null, polls.open.documentId);
    expect(anonymous.status).toBe(403);
  });

  it.each([...TEST_ROLES])(
    "as %s: exactly the polls the single read answers, with the identical body, in order",
    async (role) => {
      const expected: Results[] = [];
      const seen = new Set<number>();
      for (const address of addresses) {
        const single = await t.api<Results>(role, `/api/polls/${address}/results`);
        expect([200, 404], `${role} ${address}`).toContain(single.status);
        if (single.status === 200 && !seen.has(single.body.poll.id)) {
          seen.add(single.body.poll.id);
          expected.push(single.body);
        }
      }
      const res = await batch(role, addresses.join(","));
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(expected);
      // Never a draft, the draft-only document or a missing id.
      const listed = res.body.data.map((row) => row.poll.documentId);
      expect(listed).not.toContain(draftOnly.documentId);
      expect(listed).not.toContain("k3m9x0000000000000000999");
    },
    120_000,
  );

  it("decides visibility per poll and caller", async () => {
    const all = Object.values(polls)
      .map((poll) => poll.documentId)
      .join(",");
    const questions = async (role: TestRole) =>
      (await batch(role, all)).body.data.map((row) => row.poll.question);
    // Guests: only the polls opened to guests.
    expect(await questions("guest")).toEqual(["IT batch guests read", "IT batch guests vote"]);
    // A member of Engineering: everything but the Sales poll.
    expect(await questions("member")).toEqual([
      "IT batch open",
      "IT batch engineering",
      "IT batch guests read",
      "IT batch guests vote",
      "IT batch hidden from guests",
    ]);
    // Moderators see every poll, but vote only in their audience.
    const editor = (await batch("editor", all)).body.data;
    expect(editor.map((row) => row.poll.question)).toContain("IT batch sales");
    expect(editor.find((row) => row.poll.question === "IT batch sales")?.canVote).toBe(false);
  });

  it("counts each voter's first ballot and gives each caller their own vote", async () => {
    const ids = [polls.open.documentId, polls.engineering.documentId, polls.guestsVote.documentId];
    const member = (await batch("member", ids.join(","))).body.data;
    expect(member.map((row) => [row.counts, row.total, row.myVoteIndex])).toEqual([
      [[1, 2, 1], 4, 0],
      [[0, 0, 2], 2, 2],
      [[1, 1, 0], 2, 0],
    ]);
    const guest = (await batch("guest", ids.join(","))).body.data;
    expect(guest).toHaveLength(1);
    expect(guest[0]).toMatchObject({ counts: [1, 1, 0], myVoteIndex: 1, canVote: true });
  });

  it("keeps addressing a poll by documentId across a republish", async () => {
    await t.strapi.documents(POLL).update({
      documentId: polls.open.documentId,
      data: { question: "IT batch open v2" },
    });
    await t.strapi.documents(POLL).publish({ documentId: polls.open.documentId });
    const [row] = (await batch("member", polls.open.documentId)).body.data;
    expect(row?.poll.question).toBe("IT batch open v2");
    expect(row?.poll.id).not.toBe(polls.open.id);
    expect(row).toMatchObject({ counts: [1, 2, 1], total: 4, myVoteIndex: 0 });
    // The old published row id is gone: absent, like a missing poll.
    expect((await batch("member", String(polls.open.id))).body.data).toEqual([]);
  });

  it("refuses a malformed or over-long id list with a 400", async () => {
    for (const ids of ["", "abc", `${polls.open.documentId},1.5`, ","]) {
      const res = await batch("member", ids);
      expect({ ids, status: res.status }).toEqual({ ids, status: 400 });
    }
    const tooMany = Array.from({ length: 51 }, (_, i) => String(i + 1)).join(",");
    const res = await batch("member", tooMany);
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toBe("At most 50 ids");
    const none = await t.api<{ error?: { message?: string } }>("member", "/api/poll-results");
    expect(none.status).toBe(400);
    expect(none.body.error?.message).toBe("ids required");
  });
});
