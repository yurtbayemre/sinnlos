import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { authoringApi, settleFanouts, storedRevision } from "./authoring.test.helper";
import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";

/**
 * The v0.28 retention janitors on the real query engine (M11; owner
 * decisions 2026-10-23; plan rev2 §5 + rev3 R6). The rules are pinned as
 * pure functions next to each module; this pins what only a database
 * shows, on SQLite and Postgres:
 *   - ack-janitor: read confirmations of a document gone in every state
 *     go, with their user link rows; a draft-only document keeps them;
 *   - rsvp-janitor: every row of the event decides (a past draft of an
 *     upcoming event keeps the answers, and the reverse), a gone event
 *     loses them;
 *   - poll-voter-janitor (utils/poll-voter-retention.ts): duplicates go,
 *     the voter links go, the counts stay identical, every row is stamped,
 *     the revision advances, and the poll can no longer reopen (Document
 *     Service, authoring route) or take a vote;
 *   - notification-janitor: a blocked person keeps their old anchor, so an
 *     unblock and a re-publish send nothing again; once the source is gone
 *     in every state the old anchor goes; a training anchor of a deleted
 *     course goes, a malformed one stays;
 *   - DELETE /api/notifications/:id refuses every anchored row.
 */

const ACK = "api::acknowledgement.acknowledgement";
const ANNOUNCEMENT = "api::announcement.announcement";
const EVENT = "api::event.event";
const RSVP = "api::event-rsvp.event-rsvp";
const POLL = "api::poll.poll";
const VOTE = "api::poll-vote.poll-vote";
const NOTIFICATION = "api::notification.notification";
const USER = "plugin::users-permissions.user";
const DAY = 86_400_000;

interface AckJanitor {
  pruneAcknowledgements(strapi: unknown): Promise<number>;
}
interface RsvpJanitor {
  pruneRsvps(strapi: unknown, now?: Date): Promise<number>;
}
interface PollVoterRetention {
  unlinkPollVoters(strapi: unknown, now?: Date): Promise<number>;
}
interface NotificationJanitor {
  pruneNotifications(strapi: unknown, now?: Date): Promise<number>;
  pruneOrphanedAnchors(strapi: unknown, now?: Date): Promise<number>;
}
interface Ballots {
  countPollBallots(
    strapi: unknown,
    pollId: number,
    callerId: number | null,
    optionCount: number,
  ): Promise<{ counts: number[]; total: number }>;
}

describe.each(testEngines())("v0.28 retention janitors on %s", (engine) => {
  let t: TestStrapi;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
  });

  afterAll(async () => {
    await t?.stop();
  });

  it("deletes the confirmations of documents gone in every state, with their link rows", async () => {
    const member = t.fixtures.users.member.id;
    const live = await t.strapi.documents(ANNOUNCEMENT).create({
      data: { title: "IT ack live" },
      status: "published",
    });
    const draftOnly = await t.strapi.documents(ANNOUNCEMENT).create({
      data: { title: "IT ack draft only" },
    });
    const gone = await t.strapi.documents(ANNOUNCEMENT).create({
      data: { title: "IT ack gone" },
      status: "published",
    });
    await t.strapi.documents(ANNOUNCEMENT).delete({ documentId: gone.documentId });
    const ack = (targetDocumentId: string, targetType = "announcement") =>
      t.strapi.db.query(ACK).create({
        data: { user: member, targetType, targetDocumentId, acknowledgedAt: ago(800) },
      });
    const kept = [await ack(live.documentId), await ack(draftOnly.documentId)];
    const orphan = await ack(gone.documentId);
    const orphanDocument = await ack("itdocgone00000000000000a", "document");

    const { pruneAcknowledgements } = t.requireBuilt<AckJanitor>("src/cron/prune-acknowledgements");
    await expect(pruneAcknowledgements(t.strapi)).resolves.toBe(2);
    const left = await t.strapi.db.query(ACK).findMany({ select: ["id"] });
    expect(left.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      kept.map((row) => row.id).sort((a, b) => a - b),
    );
    for (const id of [orphan.id, orphanDocument.id]) {
      expect(
        await t.strapi.db
          .query("acknowledgements_user_lnk")
          .count({ where: { acknowledgement_id: id } }),
      ).toBe(0);
    }
    await expect(pruneAcknowledgements(t.strapi)).resolves.toBe(0);
  });

  it("deletes RSVPs only when every row of the event ended 180 days ago, or the event is gone", async () => {
    const member = t.fixtures.users.member.id;
    const event = async (title: string, start: string, end: string | null) =>
      t.strapi.documents(EVENT).create({ data: { title, start, end }, status: "published" });
    const longPast = await event("IT rsvp long past", ago(400), ago(399));
    const noEnd = await event("IT rsvp no end", ago(300), null);
    const recent = await event("IT rsvp recent", ago(100), ago(99));
    // Published upcoming, its draft moved into the past: kept.
    const upcoming = await event("IT rsvp upcoming", ago(-10), ago(-11));
    await t.strapi.documents(EVENT).update({
      documentId: upcoming.documentId,
      data: { start: ago(400), end: ago(399) },
    });
    // Published long past, its draft rescheduled into the future: kept.
    const rescheduled = await event("IT rsvp rescheduled", ago(400), ago(399));
    await t.strapi.documents(EVENT).update({
      documentId: rescheduled.documentId,
      data: { start: ago(-20), end: ago(-21) },
    });
    const gone = await event("IT rsvp gone", ago(-5), null);
    await t.strapi.documents(EVENT).delete({ documentId: gone.documentId });

    const rsvp = (targetDocumentId: string) =>
      t.strapi.db.query(RSVP).create({
        data: { user: member, targetDocumentId, status: "yes", respondedAt: ago(500) },
      });
    const dropped = [
      await rsvp(longPast.documentId),
      await rsvp(noEnd.documentId),
      await rsvp(gone.documentId),
    ];
    const kept = [
      await rsvp(recent.documentId),
      await rsvp(upcoming.documentId),
      await rsvp(rescheduled.documentId),
    ];

    const { pruneRsvps } = t.requireBuilt<RsvpJanitor>("src/cron/prune-rsvps");
    await expect(pruneRsvps(t.strapi)).resolves.toBe(3);
    const left = await t.strapi.db.query(RSVP).findMany({ select: ["id"] });
    expect(left.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      kept.map((row) => row.id).sort((a, b) => a - b),
    );
    for (const row of dropped) {
      expect(
        await t.strapi.db.query("event_rsvps_user_lnk").count({ where: { event_rsvp_id: row.id } }),
      ).toBe(0);
    }
    await expect(pruneRsvps(t.strapi)).resolves.toBe(0);
  });

  describe("poll voter links (owner decision: 30 days after the close)", () => {
    let poll: Row;
    let publishedId: number;

    beforeAll(async () => {
      poll = await t.strapi.documents(POLL).create({
        data: { question: "IT voters long closed", options: ["A", "B", "C"], closesAt: ago(40) },
        status: "published",
      });
      const row = await t.strapi.db
        .query(POLL)
        .findOne({ where: { documentId: poll.documentId, publishedAt: { $notNull: true } } });
      publishedId = row?.id as number;
      const users = t.fixtures.users;
      const vote = (optionIndex: number, voter: number | null) =>
        t.strapi.db.query(VOTE).create({
          data: { poll: publishedId, optionIndex, ...(voter === null ? {} : { voter }) },
        });
      // member's first ballot counts (A); the later duplicate (B) must not.
      await vote(0, users.member.id);
      await vote(1, users.editor.id);
      await vote(1, users.member.id);
      await vote(2, users.team_lead.id);
      // A ballot whose voter is already gone counts on its own.
      await vote(0, null);
    });

    it("dedupes, unlinks and stamps under the lock; the results stay identical", async () => {
      const { countPollBallots } = t.requireBuilt<Ballots>("src/utils/poll-ballots");
      const before = await countPollBallots(t.strapi, publishedId, null, 3);
      expect(before).toMatchObject({ counts: [2, 1, 1], total: 4 });
      const revision = await storedRevision(t, POLL, poll.documentId);

      // An open poll and one closed only 10 days ago keep their links.
      const open = await t.strapi.documents(POLL).create({
        data: { question: "IT voters open", options: ["A", "B"] },
        status: "published",
      });
      const recent = await t.strapi.documents(POLL).create({
        data: { question: "IT voters recent", options: ["A", "B"], closesAt: ago(10) },
        status: "published",
      });

      const { unlinkPollVoters } = t.requireBuilt<PollVoterRetention>(
        "src/utils/poll-voter-retention",
      );
      await expect(unlinkPollVoters(t.strapi)).resolves.toBe(1);

      const votes = await t.strapi.db.query(VOTE).findMany({
        where: { poll: { documentId: poll.documentId } },
        populate: { voter: { select: ["id"] } },
      });
      expect(votes).toHaveLength(4);
      expect(votes.every((vote) => vote.voter == null)).toBe(true);
      expect(await countPollBallots(t.strapi, publishedId, null, 3)).toMatchObject({
        counts: before.counts,
        total: before.total,
      });
      const rows = await t.strapi.db
        .query(POLL)
        .findMany({ where: { documentId: poll.documentId }, select: ["votersRemovedAt"] });
      expect(rows.length).toBeGreaterThan(1);
      expect(rows.every((row) => row.votersRemovedAt != null)).toBe(true);
      expect(await storedRevision(t, POLL, poll.documentId)).toBe(revision + 1);
      for (const kept of [open, recent]) {
        const stamps = await t.strapi.db
          .query(POLL)
          .findMany({ where: { documentId: kept.documentId }, select: ["votersRemovedAt"] });
        expect(stamps.every((row) => row.votersRemovedAt == null)).toBe(true);
      }
      await expect(unlinkPollVoters(t.strapi)).resolves.toBe(0);
    });

    it("deletes the votes of a deleted poll, which still said who voted (Codex review)", async () => {
      const doomed = await t.strapi.documents(POLL).create({
        data: { question: "IT voters deleted poll", options: ["A", "B"] },
        status: "published",
      });
      const row = await t.strapi.db
        .query(POLL)
        .findOne({ where: { documentId: doomed.documentId, publishedAt: { $notNull: true } } });
      const ballots = [
        await t.strapi.db.query(VOTE).create({
          data: { poll: row?.id, optionIndex: 0, voter: t.fixtures.users.member.id },
        }),
        await t.strapi.db.query(VOTE).create({
          data: { poll: row?.id, optionIndex: 1, voter: t.fixtures.users.editor.id },
        }),
      ].map((vote) => vote.id as number);
      await t.strapi.documents(POLL).delete({ documentId: doomed.documentId });
      // The delete cascades the poll links only: the ballots and their voters stay.
      expect(await t.strapi.db.query(VOTE).count({ where: { id: { $in: ballots } } })).toBe(2);
      const kept = await t.strapi.db
        .query(VOTE)
        .count({ where: { poll: { documentId: poll.documentId } } });

      const { unlinkPollVoters } = t.requireBuilt<PollVoterRetention>(
        "src/utils/poll-voter-retention",
      );
      await unlinkPollVoters(t.strapi);
      expect(await t.strapi.db.query(VOTE).count({ where: { id: { $in: ballots } } })).toBe(0);
      expect(
        await t.strapi.db.query(VOTE).count({ where: { poll: { documentId: poll.documentId } } }),
      ).toBe(kept);
    });

    it("can never reopen: Document Service, authoring route, vote and form all say so", async () => {
      await expect(
        t.strapi.documents(POLL).update({
          documentId: poll.documentId,
          data: { closesAt: ago(-30) },
          status: "published",
        }),
      ).rejects.toMatchObject({
        details: { keys: ["closesAt"], codes: { closesAt: "votersRemoved" } },
      });

      const api = authoringApi(t);
      const form = await api.editable<{ votersRemoved: boolean; hasVotes: boolean }>(
        "editor",
        "polls",
        poll.documentId,
      );
      expect(form.body.data).toMatchObject({ votersRemoved: true, hasVotes: true });
      const res = await api.update(
        "editor",
        "polls",
        poll.documentId,
        { closesAt: ago(-30) },
        { status: null, version: form.body.data.version },
      );
      expect(res.status).toBe(400);
      expect(res.body.error?.details).toEqual({
        keys: ["closesAt"],
        codes: { closesAt: "votersRemoved" },
      });
      // Another field still saves.
      const fresh = await api.editable("editor", "polls", poll.documentId);
      const renamed = await api.update(
        "editor",
        "polls",
        poll.documentId,
        { question: "IT voters long closed (renamed)" },
        { status: null, version: fresh.body.data.version },
      );
      expect(renamed.status).toBe(200);
      // The publish copied the stamped draft: every row still carries the mark.
      const rows = await t.strapi.db
        .query(POLL)
        .findMany({ where: { documentId: poll.documentId }, select: ["votersRemovedAt"] });
      expect(rows.every((row) => row.votersRemovedAt != null)).toBe(true);

      const staff = await t.api<{ error?: { message: string } }>(
        "department_head",
        `/api/polls/${poll.documentId}/vote`,
        { json: { optionIndex: 0 } },
      );
      expect(staff.status).toBe(400);
      expect(staff.body.error?.message).toBe("Poll is closed");
    });
  });

  describe("notification anchors", () => {
    const janitor = () => t.requireBuilt<NotificationJanitor>("src/cron/prune-notifications");
    const pruneNotifications = (strapi: unknown) => janitor().pruneNotifications(strapi);
    const pruneOrphanedAnchors = (strapi: unknown) => janitor().pruneOrphanedAnchors(strapi);

    it("block → prune → unblock → re-publish sends nothing again; the source's delete lets the old anchor go", async () => {
      const member = t.fixtures.users.member.id;
      const announcement = await t.strapi.documents(ANNOUNCEMENT).create({
        data: { title: "IT anchor kept while blocked", audience: "all" },
        status: "published",
      });
      const documentId = announcement.documentId;
      await settleFanouts(t);
      const mine = () =>
        t.strapi.db.query(NOTIFICATION).findMany({
          where: { sourceDocumentId: documentId, recipient: member },
          select: ["id"],
        });
      expect(await mine()).toHaveLength(1);
      // Old enough for both age rules, read and unread.
      for (const row of await t.strapi.db
        .query(NOTIFICATION)
        .findMany({ where: { sourceDocumentId: documentId }, select: ["id"] })) {
        await t.strapi.db.query(NOTIFICATION).update({
          where: { id: row.id },
          data: { createdAt: ago(400), readAt: ago(300) },
        });
      }

      await t.strapi.db.query(USER).update({ where: { id: member }, data: { blocked: true } });
      try {
        await pruneNotifications(t.strapi);
        await pruneOrphanedAnchors(t.strapi);
        expect(await mine()).toHaveLength(1);
      } finally {
        await t.strapi.db.query(USER).update({ where: { id: member }, data: { blocked: false } });
      }

      await t.strapi.documents(ANNOUNCEMENT).update({
        documentId,
        data: { title: "IT anchor kept while blocked (v2)" },
      });
      await t.strapi.documents(ANNOUNCEMENT).publish({ documentId });
      await settleFanouts(t);
      expect(await mine()).toHaveLength(1);

      await t.strapi.documents(ANNOUNCEMENT).delete({ documentId });
      await expect(pruneOrphanedAnchors(t.strapi)).resolves.toBeGreaterThan(0);
      expect(await mine()).toEqual([]);
      expect(
        await t.strapi.db.query(NOTIFICATION).count({ where: { sourceDocumentId: documentId } }),
      ).toBe(0);
    });

    it("deletes an old training anchor of a deleted course, keeps a malformed one and a young one", async () => {
      const member = t.fixtures.users.member.id;
      const anchor = async (sourceDocumentId: string, createdAt: string) => {
        const row = await t.strapi.db.query(NOTIFICATION).create({
          data: {
            type: "trainingDue",
            title: "IT training anchor",
            recipient: member,
            sourceType: "course",
            sourceDocumentId,
          },
        });
        await t.strapi.db
          .query(NOTIFICATION)
          .update({ where: { id: row.id }, data: { createdAt } });
        return row;
      };
      const old = await anchor("itgonecourse000000000000@2025-01-01:soon", ago(400));
      const young = await anchor("itgonecourse000000000000@2026-01-01:expired", ago(20));
      const malformed = await anchor("itgonecourse000000000000", ago(400));
      await pruneOrphanedAnchors(t.strapi);
      const left = await t.strapi.db
        .query(NOTIFICATION)
        .findMany({ where: { title: "IT training anchor" }, select: ["id"] });
      expect(left.map((row) => row.id).sort((a, b) => a - b)).toEqual(
        [young.id, malformed.id].sort((a, b) => a - b),
      );
      expect(old.id).toBeTruthy();
    });

    it("DELETE /api/notifications/:id refuses an anchored row and deletes an un-anchored one", async () => {
      const member = t.fixtures.users.member.id;
      const anchored = await t.strapi.db.query(NOTIFICATION).create({
        data: {
          type: "announcement",
          title: "IT anchored delete",
          recipient: member,
          sourceType: "announcement",
          sourceDocumentId: "itanchoreddelete00000000",
        },
      });
      const plain = await t.strapi.db.query(NOTIFICATION).create({
        data: { type: "comment", title: "IT plain delete", recipient: member },
      });
      const refused = await t.api<{ error?: { message: string } }>(
        "member",
        `/api/notifications/${anchored.documentId}`,
        { method: "DELETE" },
      );
      expect(refused.status).toBe(400);
      expect(refused.body.error?.message).toBe(
        "Notifications of an announcement or event cannot be deleted",
      );
      expect(await t.strapi.db.query(NOTIFICATION).count({ where: { id: anchored.id } })).toBe(1);
      const deleted = await t.api("member", `/api/notifications/${plain.documentId}`, {
        method: "DELETE",
      });
      expect(deleted.status).toBeLessThan(300);
      expect(await t.strapi.db.query(NOTIFICATION).count({ where: { id: plain.id } })).toBe(0);
    });
  });
});
