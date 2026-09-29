import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestStrapi,
  testEngines,
  type Row,
  type TestRole,
  type TestStrapi,
} from "./harness.test.helper";

/**
 * Publish cycles on the real Document Service, where every publish deletes
 * the published row and creates a new one (new numeric id, same
 * documentId; draft and published rows never share an id):
 *   - comment and reaction anchors (targetType + targetDocumentId, issue #11)
 *     survive REST and Document Service republishes; while an announcement
 *     is unpublished its thread is treated like the thread of a missing
 *     target, for reads and writes, byte for byte (owner answer
 *     2026-09-29 (b); utils/target-visibility.ts), and the next publish
 *     brings it back unchanged;
 *   - a poll vote follows the poll to its new published row (the
 *     unidirectional re-link, §5.17), an RSVP follows its event (documentId
 *     anchor);
 *   - the notifications of a publish are written AFTER the publish commits
 *     (LF02, batch 7): none exist inside the publish transaction, the
 *     audience has them afterwards, and a publish that rolls back notifies
 *     nobody.
 */

const ANNOUNCEMENT = "api::announcement.announcement";
const NOTIFICATION = "api::notification.notification";

interface Notify {
  __fanoutsSettledForTest(): Promise<void>;
}

describe.each(testEngines())("publish cycles on %s", (engine) => {
  let t: TestStrapi;

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
  });

  afterAll(async () => {
    await t?.stop();
  });

  /** Ids of the draft and the published row of a document. */
  const rowIds = async (uid: string, documentId: string) => {
    const rows = await t.strapi.db.query(uid).findMany({
      where: { documentId },
      select: ["id", "publishedAt"],
    });
    return {
      draft: rows.filter((row) => row.publishedAt == null).map((row) => row.id),
      published: rows.filter((row) => row.publishedAt != null).map((row) => row.id),
    };
  };

  const republish = async (uid: string, documentId: string, data: Record<string, unknown>) => {
    await t.strapi.documents(uid).update({ documentId, data });
    await t.strapi.documents(uid).publish({ documentId });
  };

  describe("comment and reaction anchors", () => {
    let announcement: Row;
    let commentId: number;
    let reactionId: number;

    const thread = async (role: TestRole = "member") => {
      const filter = `filters[targetType][$eq]=announcement&filters[targetDocumentId][$eq]=${announcement.documentId}`;
      const comments = await t.api<{ data: { id: number; body: string }[] }>(
        role,
        `/api/comments?${filter}`,
      );
      const reactions = await t.api<{ data: { id: number; emoji: string }[] }>(
        role,
        `/api/reactions?${filter}`,
      );
      expect([comments.status, reactions.status]).toEqual([200, 200]);
      return { comments: comments.body.data, reactions: reactions.body.data };
    };

    beforeAll(async () => {
      announcement = await t.strapi.documents(ANNOUNCEMENT).create({
        data: { title: "IT cycle v1", audience: "all" },
        status: "published",
      });
      const target = { targetType: "announcement", targetDocumentId: announcement.documentId };
      const comment = await t.api<{ data: { id: number } }>("member", "/api/comments", {
        json: { data: { body: "first!", ...target } },
      });
      const reaction = await t.api<{ data: { id: number } }>("member", "/api/reactions", {
        json: { data: { emoji: "heart", reacted: true, ...target } },
      });
      expect([comment.status, reaction.status]).toEqual([201, 201]);
      commentId = comment.body.data.id;
      reactionId = reaction.body.data.id;
    });

    it("draft and published rows have different ids", async () => {
      const ids = await rowIds(ANNOUNCEMENT, announcement.documentId);
      expect(ids.draft).toHaveLength(1);
      expect(ids.published).toEqual([announcement.id]);
      expect(ids.draft[0]).not.toBe(announcement.id);
    });

    it("a REST republish (editor PUT ?status=published) keeps the thread", async () => {
      const res = await t.api(
        "editor",
        `/api/announcements/${announcement.documentId}?status=published`,
        {
          method: "PUT",
          json: { data: { title: "IT cycle v2" } },
        },
      );
      expect(res.status).toBe(200);
      const ids = await rowIds(ANNOUNCEMENT, announcement.documentId);
      expect(ids.published).toHaveLength(1);
      expect(ids.published[0]).not.toBe(announcement.id);

      const { comments, reactions } = await thread();
      expect(comments.map((c) => [c.id, c.body])).toEqual([[commentId, "first!"]]);
      expect(reactions.map((r) => [r.id, r.emoji])).toEqual([[reactionId, "heart"]]);
    });

    it("the reaction toggle still finds the existing reaction after the republish", async () => {
      const again = await t.api<{ data: { id: number } }>("member", "/api/reactions", {
        json: {
          data: {
            emoji: "heart",
            reacted: true,
            targetType: "announcement",
            targetDocumentId: announcement.documentId,
          },
        },
      });
      expect(again.status).toBe(200);
      expect(again.body.data.id).toBe(reactionId);
      expect((await thread()).reactions).toHaveLength(1);
    });

    it("an unpublished announcement's thread answers like a missing target; the next publish brings it back", async () => {
      await t.strapi.documents(ANNOUNCEMENT).unpublish({ documentId: announcement.documentId });
      expect(await rowIds(ANNOUNCEMENT, announcement.documentId)).toMatchObject({ published: [] });

      // Owner answer 2026-09-29 (b): no published row, no target. The
      // draft still resolves in findCommentTarget; target-visibility.ts
      // refuses it, so every answer equals the one for a documentId that
      // never existed (no existence oracle, §5.17).
      const GHOST = "zzzzzzzzzzzzzzzzzzzzzzzz";
      const threadOf = async (role: TestRole, documentId: string) => {
        const filter = `filters[targetType][$eq]=announcement&filters[targetDocumentId][$eq]=${documentId}`;
        const comments = await t.api(role, `/api/comments?${filter}`);
        const reactions = await t.api(role, `/api/reactions?${filter}`);
        return [comments.status, comments.text, reactions.status, reactions.text];
      };
      for (const role of ["member", "team_lead", "guest"] as const) {
        const hidden = await threadOf(role, announcement.documentId);
        expect(hidden, role).toEqual(await threadOf(role, GHOST));
        expect(hidden.slice(0, 1), role).toEqual([200]);
        expect(JSON.parse(String(hidden[1])).data, role).toEqual([]);
      }

      const write = (role: TestRole, documentId: string) =>
        Promise.all([
          t.api(role, "/api/comments", {
            json: {
              data: {
                body: "while unpublished",
                targetType: "announcement",
                targetDocumentId: documentId,
              },
            },
          }),
          t.api(role, "/api/reactions", {
            json: {
              data: {
                emoji: "celebrate",
                reacted: true,
                targetType: "announcement",
                targetDocumentId: documentId,
              },
            },
          }),
        ]);
      // Writes are refused for every caller, admin_role and editor included:
      // a missing target is refused for them as well.
      for (const role of ["member", "editor", "admin_role"] as const) {
        const [comment, reaction] = await write(role, announcement.documentId);
        const [ghostComment, ghostReaction] = await write(role, GHOST);
        expect([comment.status, comment.text], role).toEqual([
          ghostComment.status,
          ghostComment.text,
        ]);
        expect([reaction.status, reaction.text], role).toEqual([
          ghostReaction.status,
          ghostReaction.text,
        ]);
        expect(comment.status, role).toBe(400);
      }
      // Removing the own reaction by toggle is a write on the target too.
      const off = await t.api("member", "/api/reactions", {
        json: {
          data: {
            emoji: "heart",
            reacted: false,
            targetType: "announcement",
            targetDocumentId: announcement.documentId,
          },
        },
      });
      expect(off.status).toBe(400);
      // The moderators' read bypass still returns the stored rows, as it
      // does for the rows of a missing target.
      expect((await thread("editor")).comments.map((c) => c.id)).toEqual([commentId]);

      await t.strapi.documents(ANNOUNCEMENT).publish({ documentId: announcement.documentId });
      const back = await thread();
      expect(back.comments.map((c) => c.id)).toEqual([commentId]);
      expect(back.reactions.map((r) => r.id)).toEqual([reactionId]);
      expect((await thread("editor")).comments).toHaveLength(1);
    });

    it("wiki page comments survive a Document Service republish as well", async () => {
      const space = await t.strapi.documents("api::wiki-space.wiki-space").create({
        data: { name: "IT cycle space", slug: "it-cycle-space", visibility: "public" },
        status: "published",
      });
      const page = await t.strapi.documents("api::wiki-page.wiki-page").create({
        data: { title: "IT cycle page", slug: "it-cycle-page", space: space.documentId },
        status: "published",
      });
      const target = { targetType: "wiki-page", targetDocumentId: page.documentId };
      expect(
        (
          await t.api("member", "/api/comments", {
            json: { data: { body: "on a page", ...target } },
          })
        ).status,
      ).toBe(201);
      for (const version of ["v2", "v3"]) {
        await republish("api::wiki-page.wiki-page", page.documentId, {
          title: `IT cycle page ${version}`,
        });
      }
      const res = await t.api<{ data: { body: string }[] }>(
        "member",
        `/api/comments?filters[targetType][$eq]=wiki-page&filters[targetDocumentId][$eq]=${page.documentId}`,
      );
      expect(res.body.data.map((c) => c.body)).toEqual(["on a page"]);
    });
  });

  it("a poll vote follows the poll to its new published row", async () => {
    const poll = await t.strapi.documents("api::poll.poll").create({
      data: { question: "IT cycle poll", options: ["A", "B"] },
      status: "published",
    });
    expect(
      (await t.api("member", `/api/polls/${poll.id}/vote`, { json: { optionIndex: 1 } })).status,
    ).toBe(200);

    await republish("api::poll.poll", poll.documentId, { question: "IT cycle poll v2" });
    const [republished] = (await rowIds("api::poll.poll", poll.documentId)).published;
    expect(republished).not.toBe(poll.id);

    const results = await t.api<{
      total: number;
      myVoteIndex: number | null;
      poll: { question: string };
    }>("member", `/api/polls/${republished}/results`);
    expect(results.body).toMatchObject({
      total: 1,
      myVoteIndex: 1,
      poll: { question: "IT cycle poll v2" },
    });
    expect((await t.api("member", `/api/polls/${poll.id}/results`)).status).toBe(404);
    const again = await t.api("member", `/api/polls/${republished}/vote`, {
      json: { optionIndex: 0 },
    });
    expect(again.status).toBe(400);
  });

  it("an RSVP follows its event across a republish", async () => {
    const event = await t.strapi.documents("api::event.event").create({
      data: { title: "IT cycle event", start: "2026-11-20T09:00:00.000Z", rsvpEnabled: true },
      status: "published",
    });
    const rsvp = await t.api("member", "/api/event-rsvps", {
      json: { data: { targetDocumentId: event.documentId, status: "yes" } },
    });
    expect(rsvp.status).toBe(200);
    await republish("api::event.event", event.documentId, { title: "IT cycle event v2" });
    expect((await rowIds("api::event.event", event.documentId)).published).not.toEqual([event.id]);

    const summary = await t.api<{ data: { yesCount: number; myStatus: string | null }[] }>(
      "member",
      `/api/event-rsvps/summary?targets=${event.documentId}`,
    );
    expect(summary.body.data).toEqual([expect.objectContaining({ yesCount: 1, myStatus: "yes" })]);
  });

  describe("notifications of a publish are written after the commit (LF02)", () => {
    const settle = () => t.requireBuilt<Notify>("src/utils/notify").__fanoutsSettledForTest();

    const recipientsOf = async (documentId: string) => {
      const rows = await t.strapi.db.query(NOTIFICATION).findMany({
        where: { sourceDocumentId: documentId },
        populate: { recipient: { select: ["id"] } },
      });
      return rows
        .map((row) => (row.recipient as { id: number } | null)?.id)
        .sort((a, b) => Number(a) - Number(b));
    };

    /** Everyone whose role holds announcement.find: the staff roles and the `authenticated` fallback. */
    const audience = () =>
      (["admin_role", "editor", "department_head", "team_lead", "member", "authenticated"] as const)
        .map((role) => t.fixtures.users[role].id)
        .sort((a, b) => a - b);

    it("a REST publish notifies the audience, never guest", async () => {
      const res = await t.api<{ data: { documentId: string } }>(
        "admin_role",
        "/api/announcements?status=published",
        {
          json: { data: { title: "IT notify via REST", audience: "all" } },
        },
      );
      expect(res.status).toBe(201);
      await settle();
      const documentId = res.body.data.documentId;
      expect(await recipientsOf(documentId)).toEqual(audience());

      const bell = await t.api<{ data: { title: string; sourceDocumentId: string }[] }>(
        "member",
        "/api/notifications?pagination[pageSize]=100",
      );
      expect(
        bell.body.data.filter((n) => n.sourceDocumentId === documentId).map((n) => n.title),
      ).toEqual(["New announcement: IT notify via REST"]);
      const guestBell = await t.api<{ data: { sourceDocumentId: string }[] }>(
        "guest",
        "/api/notifications",
      );
      expect(guestBell.body.data.filter((n) => n.sourceDocumentId === documentId)).toEqual([]);
    });

    it("inside the publish transaction none exists yet; after the commit the audience has them", async () => {
      let documentId = "";
      let inside = -1;
      await t.strapi.db.transaction(async () => {
        const created = await t.strapi.documents(ANNOUNCEMENT).create({
          data: { title: "IT notify in a transaction", audience: "all" },
          status: "published",
        });
        documentId = created.documentId;
        // Same transaction: the published row is visible here, and a fan-out
        // running inside the publish would be too.
        expect(await t.strapi.db.query(ANNOUNCEMENT).count({ where: { documentId } })).toBe(2);
        inside = await t.strapi.db
          .query(NOTIFICATION)
          .count({ where: { sourceDocumentId: documentId } });
      });
      expect(inside).toBe(0);
      await settle();
      expect(await recipientsOf(documentId)).toEqual(audience());
    });

    it("a publish that rolls back notifies nobody", async () => {
      let documentId = "";
      await expect(
        t.strapi.db.transaction(async () => {
          const created = await t.strapi.documents(ANNOUNCEMENT).create({
            data: { title: "IT notify rolled back", audience: "all" },
            status: "published",
          });
          documentId = created.documentId;
          throw new Error("roll back the publish");
        }),
      ).rejects.toThrow("roll back the publish");
      await settle();
      expect(documentId).not.toBe("");
      expect(await t.strapi.db.query(ANNOUNCEMENT).count({ where: { documentId } })).toBe(0);
      expect(await recipientsOf(documentId)).toEqual([]);
    });
  });
});
