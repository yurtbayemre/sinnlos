import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ADMIN_ENV, contentManager, type ContentManager } from "./admin-api.test.helper";
import { authoringApi, type AuthoringApi } from "./authoring.test.helper";
import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";
import {
  holdTransaction,
  qualified,
  settle,
  testSchema,
  waitForLockWait,
} from "./pg-lock.test.helper";

/**
 * Polls through the v2 write model (deep-dive decision 06 §B1-§B3, §G2;
 * batch 15 lane 15A, plan items 2b and 8) on SQLite and Postgres 16:
 *   - a create without status is published (alwaysPublished), `draft` is
 *     refused, the author is the caller and `audience` is derived;
 *   - the option bounds: 10, 11 and 20 answers are accepted and 21 refused,
 *     over HTTP (400 details.codes.options) and through the Content
 *     Manager (the lifecycle's ValidationError); an answer of 201
 *     characters is refused over HTTP only;
 *   - the freeze after the first vote, against the PUBLISHED row: a panel
 *     draft with changed options (or anonymity), a vote, then a panel
 *     publish or a web save-and-publish of closesAt is refused and nothing
 *     moves; a save of closesAt on an unchanged poll passes;
 *   - a vote and an options change raced under the poll's lock end with
 *     one of them refused (Postgres);
 *   - a voted poll keeps its published row, the freeze's baseline (Codex
 *     review of 15A, finding 1): a panel unpublish, with or without
 *     discarding the draft, is refused and moves nothing, so the panel's
 *     and the web's options change after it stay refused; a poll without
 *     votes unpublishes as before; a voted poll that lost its published row
 *     before this release can no longer be published, from either side.
 */
const POLL = "api::poll.poll";
const P = "polls";

describe.each(testEngines())("authoring polls on %s", (engine) => {
  let t: TestStrapi;
  let api: AuthoringApi;
  let panel: ContentManager;
  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: ADMIN_ENV });
    api = authoringApi(t);
    panel = await contentManager(t);
  });
  afterAll(async () => {
    await t?.stop();
  });

  const options = (count: number) => Array.from({ length: count }, (_, i) => `Answer ${i + 1}`);
  const published = async (documentId: string) =>
    t.strapi.db.query(POLL).findOne({ where: { documentId, publishedAt: { $notNull: true } } });

  it("a create without status publishes; draft is refused; the author is the caller; audience derived", async () => {
    const res = await api.create(
      "editor",
      P,
      {
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
        departments: [t.fixtures.departments.engineering.documentId],
      },
      null,
    );
    expect(res.status, res.text).toBe(201);
    expect(res.body.data).toMatchObject({ status: "published", version: "1" });
    expect(res.body.data).not.toHaveProperty("publishAt");
    const row = await t.strapi.db.query(POLL).findOne({
      where: { documentId: res.body.data.documentId, publishedAt: { $notNull: true } },
      populate: { author: { select: ["id"] } },
    });
    expect((row?.author as { id: number }).id).toBe(t.fixtures.users.editor.id);
    expect(row?.audience).toBe("departments");
    const draft = await api.create("editor", P, { question: "x", options: ["a", "b"] }, "draft");
    expect(draft.status).toBe(400);
    expect(draft.body.error?.details).toEqual({ keys: ["status"], codes: { status: "invalid" } });
    const audience = await api.create(
      "editor",
      P,
      { question: "x", options: ["a", "b"], audience: "all" },
      null,
    );
    expect(audience.body.error?.details).toEqual({ keys: ["audience"] });
    const author = await api.create(
      "editor",
      P,
      { question: "x", options: ["a", "b"], author: t.fixtures.users.member.id },
      null,
    );
    expect(author.body.error?.details).toEqual({ keys: ["author"] });
    expect(
      (await api.create("member", P, { question: "x", options: ["a", "b"] }, null)).status,
    ).toBe(403);
  });

  it("the web's createPoll payload (departments by row id, status=published) still creates", async () => {
    const res = await t.api("editor", "/api/polls?status=published", {
      json: {
        data: {
          question: "Legacy form?",
          options: ["Yes", "No"],
          closesAt: null,
          anonymous: false,
          departments: [t.fixtures.departments.engineering.id],
          visibleToGuests: false,
          guestsCanVote: false,
        },
      },
    });
    expect(res.status, res.text).toBe(201);
  });

  describe("option bounds (plan item 2b)", () => {
    it("accepts 10, 11 and 20 answers and refuses 21 over HTTP", async () => {
      for (const count of [10, 11, 20]) {
        const res = await api.create(
          "editor",
          P,
          { question: `${count}?`, options: options(count) },
          null,
        );
        expect(res.status, `${count}: ${res.text}`).toBe(201);
      }
      const res = await api.create("editor", P, { question: "21?", options: options(21) }, null);
      expect(res.status).toBe(400);
      expect(res.body.error?.details).toEqual({
        keys: ["options"],
        codes: { options: "optionCount" },
      });
      const long = await api.create(
        "editor",
        P,
        { question: "long?", options: ["x".repeat(201), "No"] },
        null,
      );
      expect(long.body.error?.details).toEqual({
        keys: ["options"],
        codes: { options: "tooLong" },
      });
    });

    it("accepts 10, 11 and 20 answers and refuses 21 in the Content Manager (the lifecycle)", async () => {
      for (const count of [10, 11, 20]) {
        const res = await panel.createAndPublish(POLL, {
          question: `Panel ${count}?`,
          options: options(count),
        });
        expect(res.status, `${count}: ${res.text}`).toBe(200);
      }
      const res = await panel.createAndPublish(POLL, {
        question: "Panel 21?",
        options: options(21),
      });
      expect(res.status).toBe(400);
      expect(res.body.error?.name).toBe("ValidationError");
      expect(res.body.error?.message).toContain("2 to 20");
      // The per-answer length is the authoring rule's, not the lifecycle's.
      const long = await panel.createAndPublish(POLL, {
        question: "Panel long?",
        options: ["x".repeat(201), "No"],
      });
      expect(long.status, long.text).toBe(200);
    });
  });

  describe("the freeze after the first vote, against the published row (plan item 8)", () => {
    const setup = async (draftChange: Record<string, unknown>) => {
      const created = await api.create(
        "editor",
        P,
        { question: "Freeze?", options: ["A", "B"] },
        null,
      );
      expect(created.status).toBe(201);
      const documentId = created.body.data.documentId;
      // Before any vote the panel may change the draft.
      const draft = await panel.update(POLL, documentId, { question: "Freeze?", ...draftChange });
      expect(draft.status, draft.text).toBe(200);
      const vote = await t.api("member", `/api/polls/${documentId}/vote`, {
        json: { optionIndex: 1, option: "B" },
      });
      expect(vote.status, vote.text).toBe(200);
      return { documentId };
    };

    it("a panel publish of a draft with changed options is refused; options and votes stay", async () => {
      const { documentId } = await setup({ options: ["A", "C"] });
      const before = await published(documentId);
      const res = await panel.publish(POLL, documentId);
      expect(res.status).toBe(400);
      expect(res.body.error?.details).toMatchObject({
        keys: ["options"],
        codes: { options: "frozenAfterVotes" },
      });
      const after = await published(documentId);
      expect(after?.options).toEqual(["A", "B"]);
      expect(after?.id).toBe(before?.id);
      expect(
        await t.strapi.db
          .query("api::poll-vote.poll-vote")
          .count({ where: { poll: { documentId } } }),
      ).toBe(1);
    });

    it("a web Save and publish of closesAt only over that draft is refused, nothing written", async () => {
      const { documentId } = await setup({ options: ["A", "C"] });
      const form = await api.editable<{ version: string; hasVotes: boolean; options: string[] }>(
        "editor",
        P,
        documentId,
      );
      expect(form.body.data).toMatchObject({ hasVotes: true, options: ["A", "C"] });
      const res = await api.update(
        "editor",
        P,
        documentId,
        { closesAt: "2026-12-31T22:59:59.000Z" },
        { status: null, version: form.body.data.version },
      );
      expect(res.status).toBe(400);
      expect(res.body.error?.details).toEqual({
        keys: ["options"],
        codes: { options: "frozenAfterVotes" },
      });
      expect((await published(documentId))?.closesAt).toBeNull();
    });

    it("a flipped anonymity in the draft is refused the same way", async () => {
      const { documentId } = await setup({ anonymous: true });
      const res = await panel.publish(POLL, documentId);
      expect(res.status).toBe(400);
      expect(res.body.error?.details).toMatchObject({ codes: { anonymous: "frozenAfterVotes" } });
      expect((await published(documentId))?.anonymous).toBe(false);
    });

    it("the web refuses changed options early, and a save of closesAt on an unchanged poll passes", async () => {
      const created = await api.create(
        "editor",
        P,
        { question: "Close me?", options: ["A", "B"] },
        null,
      );
      const documentId = created.body.data.documentId;
      expect(
        (await t.api("member", `/api/polls/${documentId}/vote`, { json: { optionIndex: 0 } }))
          .status,
      ).toBe(200);
      const refused = await api.update(
        "editor",
        P,
        documentId,
        { options: ["A", "Z"] },
        { status: null, version: created.body.data.version },
      );
      expect(refused.status).toBe(400);
      expect(refused.body.error?.details).toEqual({
        keys: ["options"],
        codes: { options: "frozenAfterVotes" },
      });
      const close = await api.update(
        "editor",
        P,
        documentId,
        { closesAt: "2026-11-30T22:59:59.000Z", options: [" A", "B "] },
        { status: null, version: created.body.data.version },
      );
      expect(close.status, close.text).toBe(200);
      expect((await published(documentId))?.closesAt).not.toBeNull();
    });

    it.runIf(engine === "postgres")(
      "a vote and an options change at the same moment end with one refused (the poll's lock)",
      async () => {
        const created = await api.create(
          "editor",
          P,
          { question: "Race?", options: ["A", "B"] },
          null,
        );
        const documentId = created.body.data.documentId;
        const held = await holdTransaction(t);
        await held.raw(
          `SELECT revision FROM ${qualified(t, "content_versions")} WHERE target_uid = ? AND target_document_id = ? FOR UPDATE`,
          [POLL, documentId],
        );
        const change = settle(
          api.update(
            "editor",
            P,
            documentId,
            { options: ["A", "C"] },
            { status: null, version: created.body.data.version },
          ),
        );
        const vote = settle(
          t.api("member", `/api/polls/${documentId}/vote`, {
            json: { optionIndex: 1, option: "B" },
          }),
        );
        await waitForLockWait(t);
        await held.rollback();
        const [changed, voted] = await Promise.all([change, vote]);
        const statuses = [
          changed.ok ? changed.value.status : 0,
          voted.ok ? voted.value.status : 0,
        ].sort();
        // Either the change went first (the vote is a stale card: 400) or
        // the vote did (the change is frozen: 400). Never both 200.
        expect(statuses).toEqual([200, 400]);
        const row = await published(documentId);
        const votes = await t.strapi.db
          .query("api::poll-vote.poll-vote")
          .count({ where: { poll: { documentId } } });
        if (votes === 1) expect(row?.options).toEqual(["A", "B"]);
        else expect(row?.options).toEqual(["A", "C"]);
      },
    );
  });

  describe("a voted poll keeps its published row (Codex review of 15A, finding 1)", () => {
    const VOTE = "api::poll-vote.poll-vote";
    const ballots = (documentId: string) =>
      t.strapi.db.query(VOTE).count({ where: { poll: { documentId } } });
    const rowsOf = (documentId: string) =>
      t.strapi.db.query(POLL).findMany({
        where: { documentId },
        select: ["id", "publishedAt", "options", "anonymous"],
        orderBy: { id: "asc" },
      });
    const voted = async (question: string) => {
      const created = await api.create(
        "editor",
        P,
        { question, options: ["A", "B"], anonymous: true },
        null,
      );
      expect(created.status, created.text).toBe(201);
      const documentId: string = created.body.data.documentId;
      const vote = await t.api("member", `/api/polls/${documentId}/vote`, {
        json: { optionIndex: 0, option: "A" },
      });
      expect(vote.status, vote.text).toBe(200);
      return documentId;
    };
    // The read-only query of docs/DEPLOYMENT.md ("Upgrading to the v2 write
    // model", before the deploy, step 3), verbatim.
    const UNPUBLISHED_VOTED_POLLS = `SELECT DISTINCT p.document_id, p.question
     FROM polls p
     JOIN poll_votes_poll_lnk l ON l.poll_id = p.id
    WHERE NOT EXISTS (SELECT 1 FROM polls q
                       WHERE q.document_id = p.document_id
                         AND q.published_at IS NOT NULL);`;
    const unpublishedVotedPolls = async (): Promise<string[]> => {
      type Row = { document_id: string };
      if (engine === "postgres") {
        const held = await holdTransaction(t);
        try {
          await held.raw(`SET LOCAL search_path TO "${testSchema(t)}"`);
          const result = (await held.raw(UNPUBLISHED_VOTED_POLLS)) as { rows: Row[] };
          return result.rows.map((row) => row.document_id);
        } finally {
          await held.rollback();
        }
      }
      const knex = (
        t.strapi.db as unknown as { connection: { raw(sql: string): Promise<unknown> } }
      ).connection;
      return ((await knex.raw(UNPUBLISHED_VOTED_POLLS)) as Row[]).map((row) => row.document_id);
    };
    const webChange = async (documentId: string) => {
      const form = await api.editable("editor", P, documentId);
      expect(form.status, form.text).toBe(200);
      return api.update(
        "editor",
        P,
        documentId,
        { options: ["X", "Y"], anonymous: false },
        { status: null, version: form.body.data.version },
      );
    };

    it.each([false, true])(
      "a panel unpublish (discardDraft %s) is refused and moves nothing; the change after it stays refused",
      async (discardDraft) => {
        const question = `Withdraw ${String(discardDraft)}?`;
        const documentId = await voted(question);
        const before = await rowsOf(documentId);
        const res = await panel.unpublish(POLL, documentId, { discardDraft });
        expect(res.status, res.text).toBe(400);
        expect(res.body.error?.details).toEqual({ keys: ["_form"] });
        expect(await rowsOf(documentId)).toEqual(before);
        expect(await ballots(documentId)).toBe(1);
        // The Content Manager: the change, then a publish.
        const draft = await panel.update(POLL, documentId, {
          question,
          options: ["X", "Y"],
          anonymous: false,
        });
        expect(draft.status).toBe(400);
        expect(draft.body.error?.details).toMatchObject({
          keys: ["anonymous", "options"],
          codes: { anonymous: "frozenAfterVotes", options: "frozenAfterVotes" },
        });
        expect((await panel.publish(POLL, documentId)).status).toBe(200);
        // The authoring controller: the web's save of the same change.
        const web = await webChange(documentId);
        expect(web.status).toBe(400);
        expect(web.body.error?.details).toMatchObject({
          codes: { anonymous: "frozenAfterVotes", options: "frozenAfterVotes" },
        });
        expect(await published(documentId)).toMatchObject({ options: ["A", "B"], anonymous: true });
        expect(await ballots(documentId)).toBe(1);
      },
    );

    it.each([false, true])(
      "a poll without votes still unpublishes (discardDraft %s) and republishes with new options",
      async (discardDraft) => {
        const question = `Unvoted ${String(discardDraft)}?`;
        const created = await api.create("editor", P, { question, options: ["A", "B"] }, null);
        expect(created.status, created.text).toBe(201);
        const documentId: string = created.body.data.documentId;
        const res = await panel.unpublish(POLL, documentId, { discardDraft });
        expect(res.status, res.text).toBe(200);
        expect(await published(documentId)).toBeNull();
        const draft = await panel.update(POLL, documentId, { question, options: ["X", "Y"] });
        expect(draft.status, draft.text).toBe(200);
        expect((await panel.publish(POLL, documentId)).status).toBe(200);
        expect((await published(documentId))?.options).toEqual(["X", "Y"]);
      },
    );

    it("a voted poll unpublished before this release can no longer be published, from either side", async () => {
      const question = "Withdrawn before the release?";
      const documentId = await voted(question);
      expect(await unpublishedVotedPolls()).not.toContain(documentId);
      // The unpublish the guard used to let through: the same Content
      // Manager call, with the ballot count hidden from the guard once.
      const votes = t.strapi.db.query(VOTE) as unknown as {
        count(params: unknown): Promise<number>;
      };
      const count = votes.count;
      votes.count = async () => {
        votes.count = count;
        return 0;
      };
      let res: Awaited<ReturnType<typeof panel.unpublish>>;
      try {
        res = await panel.unpublish(POLL, documentId, { discardDraft: true });
      } finally {
        votes.count = count;
      }
      expect(res.status, res.text).toBe(200);
      expect(await published(documentId)).toBeNull();
      // The ballot survives the unpublish (it now links the draft), and the
      // deployment guide's query lists the poll.
      expect(await ballots(documentId)).toBe(1);
      expect(await unpublishedVotedPolls()).toContain(documentId);
      // The web's save of the change, published by the poll's status mode.
      const web = await webChange(documentId);
      expect(web.status, web.text).toBe(400);
      expect(web.body.error?.details).toEqual({ keys: ["_form"] });
      // The Content Manager: a draft save reaches no voter; its publish is refused.
      const draft = await panel.update(POLL, documentId, {
        question,
        options: ["X", "Y"],
        anonymous: false,
      });
      expect(draft.status, draft.text).toBe(200);
      const publish = await panel.publish(POLL, documentId);
      expect(publish.status).toBe(400);
      expect(publish.body.error?.details).toEqual({ keys: ["_form"] });
      expect(await published(documentId)).toBeNull();
      expect(await ballots(documentId)).toBe(1);
    });
  });

  it("the list and the form read: moderators only, with hasVotes", async () => {
    const list = await api.list<{ documentId: string; label: string; status: string }>(
      "editor",
      P,
      "q=lunch",
    );
    expect(list.status).toBe(200);
    expect(list.body.data.map((row) => row.label)).toContain("Lunch?");
    expect(list.body.data[0]).not.toHaveProperty("ownerDepartment");
    expect((await api.list("editor", P, "owner=department")).status).toBe(400);
    expect((await api.list("department_head", P)).status).toBe(403);
  });
});
